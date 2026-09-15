import type { ChatTurn } from '../chat-history'
import { loadTurns, saveTurn } from '../chat-history'
import { fetchSwapHistory, type SwapRecord } from './history'

/**
 * Recording trades the ledger has but the database does not.
 *
 * The app only ever wrote a turn when a trade was made *in this browser, while
 * signed in*. Everything else — trades from before the sync existed, from
 * another device, or from a session whose sign-in silently failed — lived only
 * on Stellar. A user who cleared their cache saw an empty history beside an
 * account with fourteen real swaps in it.
 *
 * The ledger is the authority on what happened, so it is the source here. Each
 * swap it reports becomes a turn keyed by its transaction hash, which makes the
 * write idempotent: running this twice writes the same rows rather than
 * duplicating them, and a turn the user already has is left exactly as it is.
 *
 * **What a backfilled turn cannot recover.** Agent reasoning, the competition,
 * which strategy won — none of that is on-chain, and inventing it would be
 * worse than leaving it absent. A backfilled row says what the chain says: this
 * trade happened, here is the amount, here is the link. Turns the app recorded
 * properly keep their full detail because they are never overwritten.
 */

/** Marks a turn reconstructed from the ledger rather than recorded live. */
export const BACKFILL_WINNER = 'onchain'

/** A stable id per transaction, so re-running writes the same row. */
function turnIdFor(record: SwapRecord): string {
  return `onchain:${record.txHash}`
}

/**
 * What a ledger swap says, in the words a history row uses.
 *
 * Deliberately plain. This is a record of a transaction, not a reconstruction
 * of an intent nobody kept, and phrasing it as though the user had typed it
 * would put invented text in their history.
 */
function describe(record: SwapRecord): string {
  const verb = record.kind === 'limit' ? 'Limit order' : 'Swap'
  return `${verb}: ${record.sentAmount} ${record.sentAsset} to ${record.receivedAmount} ${record.receivedAsset}`
}

function toTurn(record: SwapRecord, chain: string): ChatTurn {
  return {
    id: turnIdFor(record),
    chain,
    text: describe(record),
    createdAt: record.settledAt,
    // Empty rather than fabricated: no competition produced this row.
    proposals: {},
    winner: BACKFILL_WINNER,
    txHash: record.txHash,
    bundle: [
      {
        label: record.kind === 'limit' ? 'Place order' : 'Swap',
        hash: record.txHash,
        explorerUrl: record.explorerUrl,
      },
    ],
  }
}

export interface BackfillResult {
  /** Trades found on the ledger. */
  found: number
  /** Trades written because nothing already held them. */
  written: number
}

export interface BackfillOptions {
  /** Injected in tests. */
  fetchHistory?: typeof fetchSwapHistory
  /** Injected in tests. */
  existing?: (chain: string) => ChatTurn[]
  /** Injected in tests. */
  record?: (turn: ChatTurn) => void
}

/**
 * Writes any ledger trade the history does not already hold.
 *
 * Every swap the account has made is offered, not only the ones this app built:
 * a trade made elsewhere is still a trade the user made, and hiding it would
 * make their own history disagree with their own account.
 *
 * Returns counts rather than throwing. A backfill is a convenience running
 * behind a history view, and failing it must not break the view.
 */
export async function backfillFromLedger(
  account: string,
  chain: string,
  options: BackfillOptions = {}
): Promise<BackfillResult> {
  if (chain !== 'stellar') return { found: 0, written: 0 }

  const readLedger = options.fetchHistory ?? fetchSwapHistory
  const readExisting = options.existing ?? loadTurns
  const write = options.record ?? saveTurn

  let records: SwapRecord[]
  try {
    records = await readLedger(account, { onlyThisApp: false, limit: 100 })
  } catch {
    // The ledger being briefly unreachable is not a failure worth surfacing
    // here; the next render tries again.
    return { found: 0, written: 0 }
  }

  // Both the ledger's own id and any hash a recorded turn already references,
  // so a trade the app captured properly is never replaced by a plainer
  // reconstruction of itself.
  const known = new Set<string>()
  for (const turn of readExisting(chain)) {
    known.add(turn.id)
    if (turn.txHash !== undefined) known.add(`onchain:${turn.txHash}`)
    for (const step of turn.bundle ?? []) {
      if (step.hash !== undefined) known.add(`onchain:${step.hash}`)
    }
  }

  let written = 0
  for (const record of records) {
    if (known.has(turnIdFor(record))) continue
    write(toTurn(record, chain))
    written += 1
  }

  return { found: records.length, written }
}
