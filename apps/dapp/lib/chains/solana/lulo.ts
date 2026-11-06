import { isAddress } from '@solana/kit'
import { z } from 'zod'

import {
  ChainActionRefused,
  quotedApy,
  tokenBySymbol,
  toBaseUnits,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
  type VenuePosition,
  type VenueQuote,
  takesOnly,
} from '../types'
import {
  assertDepositAmount,
  assertExitAccounts,
  assertExitAmount,
  solanaEarnAssertSafe,
} from './assert-safe'
import { venueFetch } from './http'
import { LULO_EXIT_POLICY, LULO_POLICY, LULO_PROGRAM } from './programs'
import { fromBaseUnits, SOLANA_TOKENS } from './tokens'

const LULO_API = 'https://api.lulo.fi'
const USDC_DECIMALS = 6
const BASE_UNITS_PER_USDC = 1_000_000

/**
 * Asked for instead of a figure when emptying a position. Asking for more than is held paid out
 * exactly the whole balance in a simulation on 5 November 2026, interest included, while asking for
 * the figure itself can leave what accrued since it was read. Lulo documents neither, so this rests
 * on that simulation: were it to stop holding, the network rejects it and nothing moves. Lulo's API
 * failed outright on 10,000,000,000,000.
 */
const WHOLE_POSITION_ASK = 99_999_999

const Deposit = z.object({
  transaction: z.string().min(1),
  simulateError: z.string().nullable().optional(),
})

const Rates = z.object({ protected: z.object({ CURRENT: z.number().finite().positive() }) })

const Account = z.object({
  maxWithdrawable: z.object({ protected: z.record(z.string(), z.number().finite()) }),
})

export interface LuloOptions {
  apiKey: string
}

/**
 * Lulo Protected. Off unless `LULO_API_KEY` is set, because Lulo's docs require one.
 *
 * `protectedAmount` is in display units. Lulo's docs show `1000000` beside a USDC
 * mint, but a live build for that value deposited 1,000,000 USDC, so the amount in
 * every returned transaction is checked against the request.
 *
 * Getting out goes through Lulo's API too. Lulo publishes no interface for its program, so neither
 * a withdrawal nor the value of a position can be worked out from the chain alone with confidence.
 */
export function createLuloVenue(options: LuloOptions): ChainVenue {
  const headers = { 'x-api-key': options.apiKey }

  async function readApy(): Promise<PreparedAction['apy']> {
    const { status, body } = await venueFetch(`${LULO_API}/v1/rates.getRates`, {
      label: 'Lulo',
      headers,
    }).catch(() => ({ status: 0, body: undefined }))
    const rates = Rates.safeParse(body)
    return status === 200 && rates.success
      ? { basePercent: rates.data.protected.CURRENT }
      : undefined
  }

  function checkedDeposit(
    request: ChainActionRequest,
    account: string
  ): { token: ChainToken; amount: string } {
    if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
    const token = tokenBySymbol(SOLANA_TOKENS, request.tokenIn)
    if (request.kind !== 'supply' || token === undefined || token.symbol !== 'USDC') {
      throw new ChainActionRefused(
        `Lulo here takes USDC deposits only, not ${request.tokenIn}. Try "supply 10 USDC on Lulo".`
      )
    }
    return { token, amount: toBaseUnits(request.amount, token.decimals) }
  }

  async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
    checkedDeposit(request, account)
    return quotedApy(await readApy())
  }

  /**
   * What Lulo says can leave now, interest included, which is its own reading of the chain rather
   * than this server's. Only Protected: Boost is a separate two-step exit that isn't built here.
   */
  async function positions(account: string): Promise<VenuePosition[]> {
    if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
    const usdc = tokenBySymbol(SOLANA_TOKENS, 'USDC')
    const { status, body } = await venueFetch(
      `${LULO_API}/v1/account.getAccount?owner=${account}`,
      { label: 'Lulo', headers }
    )
    const read = Account.safeParse(body)
    if (status !== 200 || !read.success || usdc === undefined) {
      throw new ChainActionRefused(
        'Lulo couldn’t say what you hold just now. Nothing was signed or sent, so try again in a moment.'
      )
    }
    const value = read.data.maxWithdrawable.protected[usdc.id] ?? 0
    const base = Math.floor(value * BASE_UNITS_PER_USDC)
    return base > 0
      ? [
          {
            slot: 'supplied',
            symbol: 'USDC',
            amount: fromBaseUnits(BigInt(base).toString(), USDC_DECIMALS),
          },
        ]
      : []
  }

  async function prepareWithdraw(
    request: ChainActionRequest,
    account: string
  ): Promise<PreparedAction> {
    if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
    const token = tokenBySymbol(SOLANA_TOKENS, request.tokenIn)
    if (token === undefined || token.symbol !== 'USDC') {
      throw new ChainActionRefused(
        `Lulo here pays back USDC only, not ${request.tokenIn}. Try "withdraw 10 USDC from Lulo". Nothing was signed or sent.`
      )
    }
    const figure = BigInt(toBaseUnits(request.amount, token.decimals))
    const whole = request.wholePosition === true && Number(request.amount) < WHOLE_POSITION_ASK
    const asked = whole ? String(WHOLE_POSITION_ASK) : request.amount
    const baseUnits = BigInt(toBaseUnits(asked, token.decimals))

    // The program pays out what's held when asked for more, so asking too much wouldn't fail and
    // the card would name a figure nobody receives.
    if (!whole) {
      const [held] = await positions(account)
      if (held === undefined || figure > BigInt(toBaseUnits(held.amount, token.decimals))) {
        throw new ChainActionRefused(
          `You can withdraw ${held?.amount ?? '0'} USDC from Lulo Protected right now, which is less than ${request.amount}. Nothing was signed or sent.`
        )
      }
    }

    const { status, body } = await venueFetch(
      `${LULO_API}/v1/generate.transactions.withdrawProtected`,
      {
        label: 'Lulo',
        method: 'POST',
        headers,
        body: { owner: account, mintAddress: token.id, amount: Number(asked) },
      }
    )
    const built = Deposit.safeParse(body)
    if (status !== 200 || !built.success) {
      throw new ChainActionRefused(
        'Lulo could not build this withdrawal right now. Nothing was signed or sent, so try again in a moment.'
      )
    }
    if (built.data.simulateError !== undefined && built.data.simulateError !== null) {
      throw new ChainActionRefused(
        'This withdrawal would fail. Check how much you have on Lulo, and that you have a little SOL for fees, then try again. Nothing was signed or sent.'
      )
    }
    const { transaction } = built.data
    assertExitAccounts(transaction, account, LULO_EXIT_POLICY)
    assertExitAmount(transaction, LULO_EXIT_POLICY.rules, baseUnits)

    return {
      venueId: 'lulo',
      venueName: 'Lulo Protected',
      kind: 'withdraw',
      summary: whole
        ? `Withdraw all your USDC from Lulo Protected to your wallet, about ${request.amount} with interest.`
        : `Withdraw ${request.amount} USDC from Lulo Protected to your wallet.`,
      pay: { amount: request.amount, symbol: 'USDC' },
      receive: { amount: request.amount, symbol: 'USDC', approximate: whole },
      notes: [
        'Lulo’s own server builds this transaction and reports your balance. I check that it pays only your wallet, but this withdrawal can’t be built here if that server is down.',
        'It comes out of the lending protocols Lulo uses. If too little is free right now, the network rejects this, nothing moves, and you lose only the small network fee.',
        ...(whole
          ? [
              'To leave no interest behind, this asks for more than you hold, and Lulo’s program pays out what you have. Lulo doesn’t document that, so if it changes the withdrawal fails rather than paying anything else.',
            ]
          : []),
      ],
      signing: { family: 'solana', transaction },
    }
  }

  async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
    if (request.kind === 'withdraw') return prepareWithdraw(request, account)
    const { token, amount } = checkedDeposit(request, account)

    const apy = await readApy()
    const { status, body } = await venueFetch(`${LULO_API}/v1/generate.transactions.deposit`, {
      label: 'Lulo',
      method: 'POST',
      headers,
      body: {
        owner: account,
        mintAddress: token.id,
        protectedAmount: Number(request.amount),
      },
    })
    const deposit = Deposit.safeParse(body)
    if (status !== 200 || !deposit.success) {
      throw new ChainActionRefused(
        'Lulo could not build this deposit right now. Nothing was signed or sent, so try again in a moment.'
      )
    }
    if (deposit.data.simulateError !== undefined && deposit.data.simulateError !== null) {
      throw new ChainActionRefused(
        'This deposit would fail. Check your USDC balance, and that you have a little SOL for fees, then try again.'
      )
    }
    assertDepositAmount(deposit.data.transaction, LULO_PROGRAM, amount)

    return {
      venueId: 'lulo',
      venueName: 'Lulo Protected',
      kind: 'supply',
      summary: `Deposit ${request.amount} USDC into Lulo Protected, which lends it across Solana lending protocols.`,
      pay: { amount: request.amount, symbol: 'USDC' },
      apy,
      notes: [
        'The cover here is first-loss funding from other depositors, not insurance. It has a limit, and a large enough failure could still lose you money.',
        `${apy === undefined ? 'I couldn’t read the current rate just now, and the rate' : 'The rate'} changes often and is not a promise.`,
        'Withdrawals depend on the liquidity of the protocols Lulo lends to and can be delayed.',
      ],
      signing: { family: 'solana', transaction: deposit.data.transaction },
    }
  }

  return {
    id: 'lulo',
    name: 'Lulo Protected',
    kinds: ['supply', 'withdraw'],
    assertCanFollow: takesOnly('Lulo', ['USDC']),
    quote,
    prepare,
    positions,
    assertSafe: solanaEarnAssertSafe(LULO_POLICY, LULO_EXIT_POLICY),
  }
}
