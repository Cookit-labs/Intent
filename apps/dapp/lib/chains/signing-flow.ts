import type { SignedOutcome, SignedPayload, SigningPayload } from './types'
import {
  CHECK_WALLET,
  accountMismatch,
  afterSubmit,
  afterWallet,
  walletSends,
} from '../weave/cashout-view'

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
      error: `${CHECK_WALLET} If it did not go out, send a new message to start again.`,
    }
  }
  return step
}

/**
 * Hands signed bytes to the server. A dropped connection or an answer that can't be read, such
 * as the platform's own page when it stops the function, says nothing about whether they went
 * out, so it comes back as no answer, which `afterSubmitting` reads as pending.
 */
export async function submitSigned(url: string, body: unknown): Promise<unknown> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
