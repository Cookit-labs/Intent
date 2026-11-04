import type { ChainSlug } from '@intent/types'

/**
 * Doing something on a chain that is not Stellar, in three moves: prepare on the
 * server, sign in the wallet, submit. Each chain supplies a `ChainModule`; the
 * routes, the hook and the chat card know nothing about any chain in particular.
 */

export type ChainWithActions = Extract<ChainSlug, 'solana' | 'sui' | 'near'>

export type ChainActionKind = 'swap' | 'supply' | 'stake'

/** What the user asked for. Amounts are decimal text in display units. */
export interface ChainActionRequest {
  kind: ChainActionKind
  amount: string
  tokenIn: string
  /** Swaps only. */
  tokenOut?: string | undefined
  /** A venue the user named. Absent means the chain's default for this kind. */
  venue?: string | undefined
}

export interface NearTransaction {
  receiverId: string
  actions: {
    type: 'FunctionCall'
    params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string }
  }[]
}

/** What the wallet is asked to sign. Base64 for Solana and Sui. */
export type SigningPayload =
  | { family: 'solana'; transaction: string }
  | { family: 'sui'; transaction: string }
  | { family: 'near'; transactions: NearTransaction[] }
  | { family: 'evm'; chainId: number; to: string; data: string; value: '0' }
  | { family: 'stellar'; xdr: string; account: string }

/**
 * What a wallet gives back. Solana, Sui and Stellar wallets return signed bytes the
 * server checks and submits. NEAR and EVM wallets send the transactions themselves.
 */
export type SignedPayload =
  | { family: 'solana'; signedTransaction: string }
  | { family: 'sui'; transaction: string; signature: string }
  | { family: 'near'; hashes: string[] }
  | { family: 'evm'; hash: string }
  | { family: 'stellar'; signedXdr: string }

export type SignedOutcome =
  | { ok: true; signed: SignedPayload }
  | { ok: false; reason: 'rejected' | 'wallet_error'; detail?: string }

export interface PreparedAction {
  venueId: string
  venueName: string
  kind: ChainActionKind
  /** One sentence: what this does. */
  summary: string
  pay: { amount: string; symbol: string }
  /** What comes back. `approximate` when the amount can move before it lands. */
  receive?: { amount: string; symbol: string; approximate: boolean } | undefined
  /** Current rate, for savings and staking. Base and reward parts stay separate. */
  apy?: { basePercent: number; rewardPercent?: number | undefined } | undefined
  /** Plain-language risks and conditions the user reads before signing. */
  notes: string[]
  signing: SigningPayload
  /** Returned unchanged at submit, for venues whose submit step needs it. */
  context?: Record<string, string> | undefined
}

export interface SubmitInput {
  account: string
  venueId: string
  signed: SignedPayload
  context?: Record<string, string> | undefined
}

export type SubmitResult =
  | { ok: true; hash: string; explorerUrl: string }
  /**
   * `pending`: sent, but the outcome isn't known yet. The money has moved, so
   * this is not a failure, and the person must be told not to send it again.
   */
  | { ok: false; error: string; pending?: boolean }

export interface ChainToken {
  symbol: string
  /** The chain's own identifier: mint, coin type or NEP-141 account. */
  id: string
  decimals: number
  name?: string | undefined
}

/** Raised for a refusal the user should read, such as an unknown token or thin liquidity. */
export class ChainActionRefused extends Error {}

/** What a venue says it would give back, read without building anything to sign. */
export interface VenueQuote {
  receive?: { amount: string; symbol: string }
  apyPercent?: number
  valueOutUsd?: number
}

export interface ChainVenue {
  id: string
  name: string
  kinds: readonly ChainActionKind[]
  /**
   * A price for the agent race. Must not create a deposit address or any other
   * thing that costs money or leaves state behind: a race quotes every venue,
   * and only the one the user presses Review on may be built.
   */
  quote?: ((request: ChainActionRequest, account: string) => Promise<VenueQuote>) | undefined
  prepare: (request: ChainActionRequest, account: string) => Promise<PreparedAction>
  /**
   * Refuses a payload that does anything but what was asked: wrong signer, an
   * unexpected program, a transfer out. Runs on what the venue's API returned
   * before the user sees it, and again on signed bytes at submit, because the
   * venue's API and the browser are both outside what this server controls.
   */
  assertSafe: (payload: SigningPayload, account: string) => void
  /** Overrides the module's submit where a venue lands its own transactions. */
  submit?: ((input: SubmitInput) => Promise<SubmitResult>) | undefined
}

export interface ChainModule {
  chain: ChainWithActions
  tokens: readonly ChainToken[]
  venues: readonly ChainVenue[]
  defaultVenue: Partial<Record<ChainActionKind, string>>
  /** Dollars per display unit, or nothing if no live price, in which case the trade is refused. */
  priceUsd: (token: ChainToken) => Promise<number | undefined>
  /** Sends signed bytes, or records what a wallet already sent. */
  submit: (input: SubmitInput) => Promise<SubmitResult>
}

export function tokenBySymbol(
  tokens: readonly ChainToken[],
  symbol: string
): ChainToken | undefined {
  const wanted = symbol.trim().toUpperCase()
  return tokens.find((t) => t.symbol.toUpperCase() === wanted)
}

/** Base units for a decimal amount. Refuses more precision than the token has, rather than rounding. */
export function toBaseUnits(amount: string, decimals: number): string {
  const text = amount.trim()
  if (!/^\d+(\.\d+)?$/.test(text)) throw new ChainActionRefused(`"${amount}" is not an amount.`)
  const [whole = '0', fraction = ''] = text.split('.')
  if (fraction.length > decimals) {
    throw new ChainActionRefused(`This token has ${decimals} decimal places at most.`)
  }
  const digits = `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '')
  if (/^0+$/.test(digits)) throw new ChainActionRefused('The amount must be more than zero.')
  return digits
}
