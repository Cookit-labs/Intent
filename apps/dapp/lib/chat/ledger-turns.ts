import type { BundleStep, ChatTurn } from '../chat-history'
import type { SwapKind, SwapRecord } from '../swap/history'

/**
 * Past intents the ledger remembers and the browser does not.
 *
 * A cleared cache or another device loses the chat, but the transaction is on
 * the chain with this app's memo. Each is listed as an intent that opens to a
 * summary of what it did, so History and Past intents agree on what happened.
 * Only transactions stamped by this app are listed: the account's ledger also
 * holds every swap from other apps, and those are not intents.
 */

const WORDS: Record<SwapKind, (r: SwapRecord) => string> = {
  swap: (r) => `Swap ${r.sentAmount} ${r.sentAsset} to ${r.receivedAsset}`,
  limit: (r) => `Limit order: ${r.sentAmount} ${r.sentAsset} for ${r.receivedAsset}`,
  bundle: (r) => `Swap ${r.sentAmount} ${r.sentAsset} to ${r.receivedAsset}, then supply it`,
  pool: (r) => `Pool operation with ${r.sentAsset} and ${r.receivedAsset}`,
  cashout: (r) => `Cash out ${r.sentAmount} ${r.sentAsset}`,
}

export function ledgerTurns(
  records: SwapRecord[],
  chain: string,
  /** Hashes a recorded chat or cash-out already accounts for. */
  have: ReadonlySet<string>
): ChatTurn[] {
  return records
    .filter((r) => r.fromThisApp && r.kind !== 'cashout' && !have.has(r.txHash))
    .map((r) => {
      const steps: BundleStep[] | undefined =
        r.bundledWith !== undefined && r.bundledWith.length > 0
          ? [
              { label: WORDS.swap(r), hash: r.txHash, explorerUrl: r.explorerUrl },
              ...r.bundledWith.map((s) => ({
                label: s.label,
                hash: s.hash,
                explorerUrl: s.explorerUrl,
                ...(s.positionUrl !== undefined ? { positionUrl: s.positionUrl } : {}),
                ...(s.venue !== undefined ? { venue: s.venue } : {}),
              })),
            ]
          : undefined
      const kind: SwapKind = steps !== undefined ? 'bundle' : r.kind
      return {
        id: `ledger:${r.txHash}`,
        chain,
        text: WORDS[kind](r),
        createdAt: r.settledAt,
        proposals: {},
        winner: null,
        txHash: r.txHash,
        ...(steps !== undefined ? { bundle: steps } : {}),
        outcome: `Completed: sent ${r.sentAmount} ${r.sentAsset}, received ${r.receivedAmount} ${r.receivedAsset}.`,
      }
    })
}
