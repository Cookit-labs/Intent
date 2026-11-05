import type { ChainSlug } from '@intent/types'
import type { CowOrder } from './evm/cow-rules'
import type { LimitBook } from './limit'

/**
 * Doing something on a chain that is not Stellar, in three moves: prepare on the
 * server, sign in the wallet, submit. Each chain supplies a `ChainModule`; the
 * routes, the hook and the chat card know nothing about any chain in particular.
 */

export type ChainWithActions = Extract<ChainSlug, 'solana' | 'sui' | 'near' | 'avalanche' | 'monad'>

export type ChainActionKind = 'swap' | 'supply' | 'stake' | 'send' | 'limit'

/** What the user asked for. Amounts are decimal text in display units. */
export interface ChainActionRequest {
  kind: ChainActionKind
  amount: string
  /**
   * `amount` is dollars, not tokens: "$5 of SOL". Only the chat's start of an action reads this,
   * and it is swapped for a count of tokens there, so nothing past that point ever sees it.
   */
  amountIsUsd?: true | undefined
  tokenIn: string
  /** Swaps only. */
  tokenOut?: string | undefined
  /** A venue the user named. Absent means the chain's default for this kind. */
  venue?: string | undefined
  /** Sends only, exactly as typed. Where the money goes, so it is checked and never changed. */
  recipient?: string | undefined
  /** Limit orders only: the price of the non-stable token in the stable one, as typed. */
  limitPrice?: string | undefined
}

export interface NearTransaction {
  receiverId: string
  actions: {
    type: 'FunctionCall'
    params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string }
  }[]
}

/** What the wallet is asked to sign. Base64 for Solana and Sui. An EVM `value` is decimal base units. */
export type SigningPayload =
  | { family: 'solana'; transaction: string }
  | { family: 'sui'; transaction: string }
  | { family: 'near'; transactions: NearTransaction[] }
  | { family: 'evm'; chainId: number; to: string; data: string; value: string }
  /** A message, not a transaction: signing it moves nothing until the venue's server posts it. */
  | {
      family: 'evm-typed'
      chainId: number
      account: string
      typedData: { domain: object; types: object; primaryType: 'Order'; message: CowOrder }
    }
  | { family: 'stellar'; xdr: string; account: string }

/**
 * What a wallet gives back. Solana, Sui and Stellar wallets return signed bytes the
 * server checks and submits. NEAR and EVM wallets send the transactions themselves. A typed EVM
 * message comes back as a signature the server checks and posts.
 */
export type SignedPayload =
  | { family: 'solana'; signedTransaction: string }
  | { family: 'sui'; transaction: string; signature: string }
  | { family: 'near'; hashes: string[] }
  | { family: 'evm'; hash: string }
  | { family: 'evm-typed'; signature: string }
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
  /** A setup step: the same request must be prepared again once this one settles. */
  thenPrepareAgain?: true
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
  /** Only where every route on the chain is valued by the same source, as on NEAR. */
  valueOutUsd?: number
  /**
   * What this route costs the wallet beyond what it delivers, as a route elsewhere would not.
   * The race takes it off the route's value, at the chain's own price for this token.
   */
  walletCost?: { amount: string; symbol: string }
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
   *
   * `context` is what `prepare` issued, handed back by the browser. A venue that reads it
   * must prove the server wrote it before believing any of it. The exception is a venue that only
   * compares it with the signed bytes, and whose submit does nothing else with it, as Kamino's limit
   * orders do: anyone holding the wallet's signature can broadcast those bytes directly, so a proof
   * would stop nothing.
   */
  assertSafe: (
    payload: SigningPayload,
    account: string,
    context?: Record<string, string> | undefined
  ) => void
  /** Overrides the module's submit where a venue lands its own transactions. */
  submit?: ((input: SubmitInput) => Promise<SubmitResult>) | undefined
  /**
   * Refuses a step this venue could not run after a swap, while the swap is still unsigned. Reads
   * only: nothing is built. A venue without this can't follow a swap.
   */
  assertCanFollow?: ((step: FollowOnStep, account: string) => Promise<void>) | undefined
  /** A limit order's one-off setup cost in the native coin, kept back on top of the fee reserve. */
  limitCost?: { amount: string; symbol: string } | undefined
  /**
   * For a venue whose setup is paid once per account: what this one still owes, or nothing. Takes the
   * place of `limitCost` in the reserve, which there is only the most it can come to.
   */
  limitCostNow?:
    | ((
        request: ChainActionRequest,
        account: string
      ) => Promise<{ amount: string; symbol: string } | undefined>)
    | undefined
}

/** A step that would follow a swap. The amount isn't known until the swap has delivered it. */
export interface FollowOnStep {
  kind: ChainActionKind
  tokenIn: string
  venue?: string | undefined
  recipient?: string | undefined
}

/** `assertCanFollow` for a venue that takes only these tokens. */
export function takesOnly(
  venueName: string,
  symbols: readonly string[]
): NonNullable<ChainVenue['assertCanFollow']> {
  return async ({ tokenIn }) => {
    const wanted = tokenIn.trim().toUpperCase()
    if (symbols.some((symbol) => symbol.toUpperCase() === wanted)) return
    throw new ChainActionRefused(
      `${venueName} takes ${symbols.join(' or ')} here, not ${tokenIn}. Nothing was signed or sent.`
    )
  }
}

/**
 * One token a wallet holds. Anything that measures a change in a holding must match on `id`, never
 * on `symbol`: an unlisted token's symbol comes from its coin type or its contract, which anyone
 * can name to copy a real one.
 */
export interface TokenBalance {
  symbol: string
  id: string
  amount: string
  decimals: number
  native: boolean
  /** In this chain's token table. An unlisted token can't be traded here yet. */
  listed: boolean
}

export interface WalletBalances {
  tokens: TokenBalance[]
  /** False when some token the wallet may hold is missing from `tokens`. */
  complete: boolean
  /** Only known tokens can be read on this chain, so an unlisted one is never shown. */
  knownOnly?: boolean | undefined
  /** Symbols of listed tokens that could not be read, and so are left out rather than shown as zero. */
  unread?: string[] | undefined
}

/** Longest a balance read may take, all calls together. */
export const BALANCE_DEADLINE_MS = 15_000

export interface ChainModule {
  chain: ChainWithActions
  tokens: readonly ChainToken[]
  venues: readonly ChainVenue[]
  defaultVenue: Partial<Record<ChainActionKind, string>>
  /** Dollars per display unit, or nothing if no live price, in which case the trade is refused. */
  priceUsd: (token: ChainToken) => Promise<number | undefined>
  /** Sends signed bytes, or records what a wallet already sent. */
  submit: (input: SubmitInput) => Promise<SubmitResult>
  /** Every token the account holds, read now. Throws on a malformed account (a refusal) or an unreadable chain. */
  balances: (account: string, signal?: AbortSignal) => Promise<WalletBalances>
  /** A sentence for a symbol this chain doesn't list but a person may well type, by upper-case symbol. */
  tokenHints?: Record<string, string> | undefined
  limitBook?: LimitBook
}

/** "an Avalanche", "a Monad". */
export function withArticle(name: string): string {
  return `${/^[AEIOU]/.test(name) ? 'an' : 'a'} ${name}`
}

/**
 * A venue's rate as the race reads it: base and reward together, since the agents compare
 * one figure. No rate read means no rate here, never a zero or a guess.
 */
export function quotedApy(apy: PreparedAction['apy']): VenueQuote {
  return apy === undefined ? {} : { apyPercent: apy.basePercent + (apy.rewardPercent ?? 0) }
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
