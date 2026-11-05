import {
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  isAddress,
  type Address,
} from '@solana/kit'
import { z } from 'zod'

import { base64FromBytes, bytesFromBase64 } from '../base64'
import {
  ChainActionRefused,
  quotedApy,
  tokenBySymbol,
  toBaseUnits,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
  type VenueQuote,
} from '../types'
import {
  assertDepositAmount,
  ASSOCIATED_TOKEN_PROGRAM,
  associatedTokenAccount,
  solanaAssertSafe,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
} from './assert-safe'
import { JUPITER_API, jupiterHeaders, venueFetch } from './http'
import { JUPITER_LEND_POLICY, JUPITER_LEND_PROGRAM } from './programs'
import { SOLANA_TOKENS } from './tokens'

/**
 * Only tokens the wallet already holds as a token account. Its SOL deposit spends
 * from a wrapped SOL account and does not wrap native SOL first, as a live
 * transaction showed, so it would fail for most wallets.
 */
const SUPPORTED = new Set(['USDC', 'USDT'])

const Rates = z.array(
  z.object({
    assetAddress: z.string(),
    supplyRate: z.union([z.string(), z.number()]).optional(),
    rewardsRate: z.union([z.string(), z.number()]).optional(),
  })
)

const Deposit = z.object({ transaction: z.string().min(1) })

/**
 * Percent from a rate. The live API returns whole basis points ("504"), though its
 * docs show a fraction ("0.025"), so both are read, and anything else is no rate.
 */
function ratePercent(rate: string | number | undefined): number | undefined {
  if (rate === undefined || rate === '') return undefined
  const value = Number(rate)
  if (!Number.isFinite(value) || value < 0) return undefined
  const percent = String(rate).includes('.') || value < 1 ? value * 100 : value / 100
  return percent <= 100 ? percent : undefined
}

const CREATE_IDEMPOTENT = 1
/** Where the deposit instruction lists the receipt token account and its mint. */
const RECIPIENT_POSITION = 2
const RECEIPT_MINT_POSITION = 6

/**
 * Puts a step in front of the deposit that opens the wallet's receipt token account.
 *
 * The deposit Jupiter's API returns assumes this account exists. For a first-time
 * depositor it doesn't, and a read-only simulation on 3 November 2026 failed with
 * `AccountNotInitialized` on `recipient_token_account`. Creating it this way is a
 * no-op when it already exists. Its accounts were all listed by the deposit, so
 * nothing new needs a signature, and the message stays unsigned until the wallet.
 */
export function withReceiptAccount(base64: string, account: string): string {
  const { messageBytes } = getTransactionDecoder().decode(bytesFromBase64(base64))
  const message = getCompiledTransactionMessageDecoder().decode(messageBytes)
  if (message.version !== 'legacy' && message.version !== 0) return base64
  const { staticAccounts, instructions } = message
  const programAt = (index: number): string | undefined => staticAccounts[index]
  if (instructions.some((i) => programAt(i.programAddressIndex) === ASSOCIATED_TOKEN_PROGRAM)) {
    return base64
  }

  const deposit = instructions.find(
    (i) => programAt(i.programAddressIndex) === JUPITER_LEND_PROGRAM
  )
  const recipientIndex = deposit?.accountIndices?.[RECIPIENT_POSITION]
  const mintIndex = deposit?.accountIndices?.[RECEIPT_MINT_POSITION]
  const recipient = recipientIndex === undefined ? undefined : staticAccounts[recipientIndex]
  const mint = mintIndex === undefined ? undefined : staticAccounts[mintIndex]
  if (
    recipientIndex === undefined ||
    mintIndex === undefined ||
    recipient === undefined ||
    mint === undefined ||
    recipient !== associatedTokenAccount(account, mint)
  ) {
    throw new ChainActionRefused(
      'This deposit would not pay into your own token account, so I refused it. Nothing was signed or sent.'
    )
  }

  const indexOf = (address: string): number => staticAccounts.indexOf(address as Address)
  const programAddressIndex = indexOf(ASSOCIATED_TOKEN_PROGRAM)
  const systemIndex = indexOf(SYSTEM_PROGRAM)
  const tokenIndex = indexOf(TOKEN_PROGRAM)
  if (programAddressIndex === -1 || systemIndex === -1 || tokenIndex === -1) {
    throw new ChainActionRefused(
      'Jupiter Lend returned a deposit I can’t complete, so nothing was signed or sent. Try again later.'
    )
  }
  const create = {
    programAddressIndex,
    accountIndices: [0, recipientIndex, 0, mintIndex, systemIndex, tokenIndex],
    data: Uint8Array.of(CREATE_IDEMPOTENT),
  }
  const bytes = getCompiledTransactionMessageEncoder().encode({
    ...message,
    instructions: [create, ...instructions],
  })
  const unsigned = new Uint8Array(1 + 64 + bytes.length)
  unsigned[0] = 1
  unsigned.set(bytes, 65)
  return base64FromBytes(unsigned)
}

export interface JupiterLendOptions {
  env?: Record<string, string | undefined>
  retryDelayMs?: number
}

export function createJupiterLendVenue(options: JupiterLendOptions = {}): ChainVenue {
  const env = options.env ?? process.env
  const shared = {
    label: 'Jupiter',
    headers: jupiterHeaders(env),
    ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
  }

  async function readApy(mint: string): Promise<PreparedAction['apy']> {
    const { status, body } = await venueFetch(`${JUPITER_API}/lend/v1/earn/tokens`, shared).catch(
      () => ({ status: 0, body: undefined })
    )
    const rates = Rates.safeParse(body)
    if (status !== 200 || !rates.success) return undefined
    const entry = rates.data.find((r) => r.assetAddress === mint)
    const basePercent = ratePercent(entry?.supplyRate)
    if (basePercent === undefined) return undefined
    const rewardPercent = ratePercent(entry?.rewardsRate)
    return rewardPercent === undefined || rewardPercent === 0
      ? { basePercent }
      : { basePercent, rewardPercent }
  }

  function checkedDeposit(
    request: ChainActionRequest,
    account: string
  ): { token: ChainToken; amount: string } {
    if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
    const token = tokenBySymbol(SOLANA_TOKENS, request.tokenIn)
    if (request.kind !== 'supply' || token === undefined || !SUPPORTED.has(token.symbol)) {
      throw new ChainActionRefused(
        `Jupiter Lend here takes USDC or USDT deposits only, not ${request.tokenIn}. Try "supply 10 USDC on Jupiter Lend".`
      )
    }
    return { token, amount: toBaseUnits(request.amount, token.decimals) }
  }

  async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
    const { token } = checkedDeposit(request, account)
    return quotedApy(await readApy(token.id))
  }

  async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
    const { token, amount } = checkedDeposit(request, account)

    const apy = await readApy(token.id)
    const { status, body } = await venueFetch(`${JUPITER_API}/lend/v1/earn/deposit`, {
      ...shared,
      method: 'POST',
      body: { asset: token.id, amount, signer: account },
    })
    const deposit = Deposit.safeParse(body)
    if (status !== 200 || !deposit.success) {
      throw new ChainActionRefused(
        'Jupiter Lend could not build this deposit right now. Nothing was signed or sent, so try again in a moment.'
      )
    }
    assertDepositAmount(deposit.data.transaction, JUPITER_LEND_PROGRAM, amount)
    const transaction = withReceiptAccount(deposit.data.transaction, account)

    return {
      venueId: 'jupiter-lend',
      venueName: 'Jupiter Lend Earn',
      kind: 'supply',
      summary: `Deposit ${request.amount} ${token.symbol} into Jupiter Lend Earn, where it is lent to borrowers.`,
      pay: { amount: request.amount, symbol: token.symbol },
      apy,
      notes: [
        `Jupiter labels this API beta, and ${apy === undefined ? 'I couldn’t read the current rate just now. The rate' : 'the rate shown is today’s. It'} changes with borrowing demand and is not a promise.`,
        'Your deposit is lent out through smart contracts. Those can fail, and vault collateral is not fully isolated from other markets on Jupiter Lend, so you could lose money.',
        'Withdrawals depend on available liquidity and can be delayed when borrowing is high. A first deposit also pays about 0.002 SOL to open the token account holding your position.',
      ],
      signing: { family: 'solana', transaction },
    }
  }

  return {
    id: 'jupiter-lend',
    name: 'Jupiter Lend Earn',
    kinds: ['supply'],
    quote,
    prepare,
    assertSafe: solanaAssertSafe(JUPITER_LEND_POLICY),
  }
}
