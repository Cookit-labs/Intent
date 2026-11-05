import { isAddress } from '@solana/kit'
import { z } from 'zod'

import {
  ChainActionRefused,
  tokenBySymbol,
  toBaseUnits,
  type ChainActionRequest,
  type ChainVenue,
  type PreparedAction,
} from '../types'
import { assertDepositAmount, solanaAssertSafe } from './assert-safe'
import { venueFetch } from './http'
import { LULO_POLICY, LULO_PROGRAM } from './programs'
import { SOLANA_TOKENS } from './tokens'

const LULO_API = 'https://api.lulo.fi'

const Deposit = z.object({
  transaction: z.string().min(1),
  simulateError: z.string().nullable().optional(),
})

const Rates = z.object({ protected: z.object({ CURRENT: z.number().finite().positive() }) })

export interface LuloOptions {
  apiKey: string
}

/**
 * Lulo Protected. Off unless `LULO_API_KEY` is set, because Lulo's docs require one.
 *
 * `protectedAmount` is in display units. Lulo's docs show `1000000` beside a USDC
 * mint, but a live build for that value deposited 1,000,000 USDC, so the amount in
 * every returned transaction is checked against the request.
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

  async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
    if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
    const token = tokenBySymbol(SOLANA_TOKENS, request.tokenIn)
    if (request.kind !== 'supply' || token === undefined || token.symbol !== 'USDC') {
      throw new ChainActionRefused(
        `Lulo here takes USDC deposits only, not ${request.tokenIn}. Try "supply 10 USDC on Lulo".`
      )
    }
    const amount = toBaseUnits(request.amount, token.decimals)

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
    kinds: ['supply'],
    prepare,
    assertSafe: solanaAssertSafe(LULO_POLICY),
  }
}
