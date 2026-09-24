import { resolveAnchor } from './anchors'
import type { OfframpExpectation } from './build-payment'
import { expectationFrom } from './build-payment'
import type { AnchorTransaction, Sep24Status } from './sep24'
import { isDeclined, isReadyToPay, readTransaction } from './sep24'
import { readAnchorToml } from './toml'

/**
 * Reads the anchor and says whether the payment can be built now.
 *
 * Server-side, and shared by the build and submit routes so the two cannot
 * drift on what "ready" means. The result is a discriminated union rather
 * than a throw because every non-ready outcome is something the client does
 * differently with: keep polling, stop and tell the user, or report a
 * configuration problem.
 */

export type ReadExpectationResult =
  | { ok: true; expectation: OfframpExpectation; tx: AnchorTransaction }
  | {
      ok: false
      code: 'unknown_anchor' | 'anchor_unreachable' | 'not_ready' | 'declined' | 'unusable'
      status?: Sep24Status
      message: string
    }

export interface ReadExpectationOptions {
  anchorId: string
  transactionId: string
  authToken: string
  fetchImpl?: typeof fetch
}

export async function readExpectation(
  options: ReadExpectationOptions
): Promise<ReadExpectationResult> {
  // Resolved for this network before the anchor is asked anything: on
  // mainnet with no off-ramp configured the message says so, rather than
  // calling a test anchor unknown.
  const resolved = resolveAnchor(options.anchorId)
  if (!resolved.ok) {
    return { ok: false, code: 'unknown_anchor', message: resolved.reason }
  }
  const anchor = resolved.anchor

  let tx: AnchorTransaction
  try {
    const toml = await readAnchorToml(anchor, options.fetchImpl)
    tx = await readTransaction(
      toml,
      { authToken: options.authToken, id: options.transactionId },
      options.fetchImpl
    )
  } catch (e) {
    return {
      ok: false,
      code: 'anchor_unreachable',
      message: e instanceof Error ? e.message : 'could not read the anchor',
    }
  }

  if (isDeclined(tx.status)) {
    return {
      ok: false,
      code: 'declined',
      status: tx.status,
      message: tx.message ?? `the anchor ended this withdrawal: ${tx.status}`,
    }
  }
  if (!isReadyToPay(tx.status)) {
    return {
      ok: false,
      code: 'not_ready',
      status: tx.status,
      message: `the anchor is still working: ${tx.status}`,
    }
  }

  try {
    return { ok: true, expectation: expectationFrom(anchor, tx), tx }
  } catch (e) {
    return {
      ok: false,
      code: 'unusable',
      status: tx.status,
      message: e instanceof Error ? e.message : 'the anchor answer could not be used',
    }
  }
}
