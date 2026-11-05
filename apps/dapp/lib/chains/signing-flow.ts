import { RACE_HEADER } from '../api/network-fetch'
import type { PreparedAction, SignedOutcome, SignedPayload, SigningPayload } from './types'
import {
  CHECK_WALLET,
  accountMismatch,
  afterSubmit,
  afterWallet,
  depositExplorerUrl,
  walletSends,
} from '../weave/cashout-view'
import { isCashoutChain } from '../weave/types'
import { evmExplorerUrl } from './evm/tokens'

type Family = SigningPayload['family']

export { accountMismatch }

/**
 * Whether handing the payload to the wallet may already move money. A wallet
 * that broadcasts for itself can send and then report an error or a decline,
 * so from the moment it is called the action must not be signed again.
 */
export function latchBeforeSign(family: Family): boolean {
  return walletSends(family)
}

export const QUOTE_EXPIRED =
  'This quote expired before you signed, so your wallet was not asked and nothing was sent. Send your request again for a fresh one.'

/** The end of what `afterSigning` says on a wallet that gave no answer. */
export const START_AGAIN = 'If it did not go out, send a new message to start again.'

/**
 * Whether a card has outlived its quote, on a chain where this is the last chance to say so. The
 * server checks the deadline before it sends signed bytes, but an EVM or NEAR wallet sends for
 * itself, and a late deposit may be refunded instead of swapped.
 */
export function quoteExpiredBeforeSigning(
  prepared: Pick<PreparedAction, 'signing' | 'context'>,
  now: number = Date.now()
): boolean {
  const deadline = prepared.context?.['deadline']
  return (
    walletSends(prepared.signing.family) && deadline !== undefined && !(Date.parse(deadline) > now)
  )
}

export type AfterSigning =
  | { next: 'submit'; signed: SignedPayload }
  /** Signed-bytes wallet declined: nothing left the device, so the card stays on offer. */
  | { next: 'review' }
  /** Signed-bytes wallet failed before anything was sent. */
  | { next: 'failed'; error: string }
  /** Self-sending wallet gave no confirmation: it may have gone out. */
  | { next: 'unknown'; error: string }

export function afterSigning(outcome: SignedOutcome, family: Family): AfterSigning {
  const step = afterWallet(outcome, family)
  if (step.next === 'check') {
    return {
      next: 'unknown',
      error: `${CHECK_WALLET} ${START_AGAIN}`,
    }
  }
  return step
}

/**
 * Hands signed bytes to the server. A dropped connection or an answer that can't be read, such
 * as the platform's own page when it stops the function, says nothing about whether they went
 * out, so it comes back as no answer, which `afterSubmitting` reads as pending.
 * The race the action came from, when it came from one, rides along so the log can credit it.
 */
export async function submitSigned(url: string, body: unknown, raceId?: string): Promise<unknown> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(raceId !== undefined ? { [RACE_HEADER]: raceId } : {}),
      },
      body: JSON.stringify(body),
    })
    return (await res.json()) as unknown
  } catch {
    return undefined
  }
}

export type AfterSubmitting =
  | { phase: 'settled'; hash: string; explorerUrl: string | undefined; latched: true }
  | { phase: 'pending'; error: string; latched: true }
  | { phase: 'failed'; error: string; latched: false }

/**
 * The server's answer to submitted signed bytes. Only an explicit clean refusal
 * releases the latch; every other answer leaves open that the money moved.
 */
export function afterSubmitting(result: unknown, family: Family): AfterSubmitting {
  const step = afterSubmit(result, family)
  if (step.next === 'tracking') {
    return {
      phase: 'settled',
      hash: step.hash,
      explorerUrl: step.explorerUrl === '' ? undefined : step.explorerUrl,
      latched: true,
    }
  }
  if (step.next === 'pending') {
    const said = (result as { error?: unknown } | null)?.error
    return {
      phase: 'pending',
      error:
        typeof said === 'string' && said.includes(' ')
          ? said
          : "This may have gone through. Check your wallet's activity before trying again.",
      latched: true,
    }
  }
  return { phase: 'failed', error: step.error, latched: false }
}

/**
 * A signature that was asked for, kept past a reload so a person who comes back and types the same
 * thing again is warned before paying twice. It warns and never blocks, so storage that fails
 * changes nothing. It is dropped only by an answer that proves nothing moved.
 */
export interface SignAttempt {
  chain: string
  account: string
  tokenIn: string
  amount: string
  at: number
  hash?: string
}

export type AttemptStorage = Pick<Storage, 'getItem' | 'setItem'>

export const ATTEMPT_WINDOW_MS = 15 * 60_000

const ATTEMPTS_KEY = 'intent.chain.attempts'

/** Reading `localStorage` can itself throw when a browser denies it. */
export function attemptStorage(): AttemptStorage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

function isAttempt(value: unknown): value is SignAttempt {
  if (typeof value !== 'object' || value === null) return false
  const a = value as Partial<SignAttempt>
  return (
    typeof a.chain === 'string' &&
    typeof a.account === 'string' &&
    typeof a.tokenIn === 'string' &&
    typeof a.amount === 'string' &&
    typeof a.at === 'number' &&
    (a.hash === undefined || typeof a.hash === 'string')
  )
}

function readAttempts(storage: AttemptStorage | undefined, now: number): SignAttempt[] {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(ATTEMPTS_KEY) ?? '[]')
    if (!Array.isArray(saved)) return []
    return saved.filter(isAttempt).filter((a) => now - a.at <= ATTEMPT_WINDOW_MS)
  } catch {
    return []
  }
}

function writeAttempts(storage: AttemptStorage | undefined, attempts: SignAttempt[]): void {
  try {
    storage?.setItem(ATTEMPTS_KEY, JSON.stringify(attempts))
  } catch {
    // The warning is an extra, and signing goes on without it.
  }
}

/** Called before the wallet opens. */
export function recordAttempt(storage: AttemptStorage | undefined, attempt: SignAttempt): void {
  writeAttempts(storage, [...readAttempts(storage, attempt.at), attempt])
}

/** Whether two records are one attempt. A hash may have been added since. */
function sameAttempt(a: SignAttempt, b: SignAttempt): boolean {
  return (
    a.at === b.at &&
    a.chain === b.chain &&
    a.account === b.account &&
    a.tokenIn === b.tokenIn &&
    a.amount === b.amount
  )
}

function forgetAttempt(storage: AttemptStorage | undefined, attempt: SignAttempt): void {
  const kept = readAttempts(storage, Date.now()).filter((a) => !sameAttempt(a, attempt))
  writeAttempts(storage, kept)
}

function addAttemptHash(
  storage: AttemptStorage | undefined,
  attempt: SignAttempt,
  hash: string
): void {
  const attempts = readAttempts(storage, Date.now())
  writeAttempts(
    storage,
    attempts.map((a) => (sameAttempt(a, attempt) ? { ...a, hash } : a))
  )
}

function walletHash(signed: SignedPayload): string | undefined {
  if (signed.family === 'evm') return signed.hash
  if (signed.family === 'near') return signed.hashes[signed.hashes.length - 1]
  return undefined
}

/**
 * What the wallet's answer says about the attempt. No step means no wallet here could sign, and a
 * declined or failed signed-bytes wallet never sent anything. A wallet that sends for itself and
 * gave no confirmation proves nothing, so that attempt stays.
 */
export function noteWalletAnswer(
  storage: AttemptStorage | undefined,
  attempt: SignAttempt,
  step: AfterSigning | undefined
): void {
  if (step === undefined || step.next === 'review' || step.next === 'failed') {
    forgetAttempt(storage, attempt)
    return
  }
  if (step.next !== 'submit') return
  const hash = walletHash(step.signed)
  if (hash !== undefined) addAttemptHash(storage, attempt, hash)
}

/**
 * What the server's answer says about the attempt. An answer lacks `pending` only if it proves
 * nothing moved, a clean refusal or a proven revert, on every chain. So this reads the answer
 * itself, where `afterSubmit` keeps a wallet that sends for itself latched regardless. A success
 * stays too, since typing it again would pay twice.
 */
export function noteSubmitAnswer(
  storage: AttemptStorage | undefined,
  attempt: SignAttempt,
  result: unknown
): void {
  const body = (typeof result === 'object' && result !== null ? result : {}) as {
    ok?: unknown
    hash?: unknown
    pending?: unknown
  }
  if (body.ok === false && body.pending !== true) {
    forgetAttempt(storage, attempt)
    return
  }
  if (body.ok === true && typeof body.hash === 'string') {
    addAttemptHash(storage, attempt, body.hash)
  }
}

/** The newest attempt at this same action inside the window, if there is one. */
export function earlierAttempt(
  storage: AttemptStorage | undefined,
  asked: Pick<SignAttempt, 'chain' | 'account' | 'tokenIn' | 'amount'>,
  now: number = Date.now()
): SignAttempt | undefined {
  const matches = readAttempts(storage, now).filter(
    (a) =>
      a.chain === asked.chain &&
      accountMismatch(a.account, asked.account) === undefined &&
      a.tokenIn.toUpperCase() === asked.tokenIn.toUpperCase() &&
      Number(a.amount) === Number(asked.amount)
  )
  return matches[matches.length - 1]
}

export interface AttemptNotice {
  text: string
  hash?: string
  explorerUrl?: string
}

function attemptExplorerUrl(chain: string, hash: string): string | undefined {
  // Read back from storage, so it can only ever be a path on the explorer.
  const safe = encodeURIComponent(hash)
  if (chain === 'monad') return evmExplorerUrl('monad', safe)
  return isCashoutChain(chain) ? depositExplorerUrl(chain, safe) : undefined
}

/** What the card says about an earlier attempt. */
export function attemptNotice(attempt: SignAttempt, now: number = Date.now()): AttemptNotice {
  const minutes = Math.max(1, Math.floor((now - attempt.at) / 60_000))
  const text = `You started this ${minutes} minute${minutes === 1 ? '' : 's'} ago, check your wallet first.`
  if (attempt.hash === undefined) return { text }
  const explorerUrl = attemptExplorerUrl(attempt.chain, attempt.hash)
  return {
    text,
    hash: attempt.hash,
    ...(explorerUrl !== undefined ? { explorerUrl } : {}),
  }
}
