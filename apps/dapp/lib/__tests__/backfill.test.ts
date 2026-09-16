import { describe, expect, it } from 'vitest'

import { backfillFromLedger } from '../swap/backfill'
import type { ChatTurn } from '../chat-history'
import type { SwapRecord } from '../swap/history'

/**
 * Recording trades the ledger has but the database does not.
 *
 * The app only wrote a turn when a trade was made in this browser while signed
 * in. Everything else — trades from before the sync existed, from another
 * device, or from a session whose sign-in silently failed — lived only on
 * Stellar. A user who cleared their cache saw an empty history beside an
 * account holding fourteen real swaps.
 *
 * Two properties carry the weight here. The write must be idempotent, because
 * this runs on every sign-in and a duplicate row per visit would be worse than
 * the gap it fixes. And a turn the app recorded properly — with its agent
 * reasoning and its bundle — must never be replaced by the plainer
 * reconstruction the ledger can offer.
 */

function record(over: Partial<SwapRecord> = {}): SwapRecord {
  return {
    txHash: 'tx111',
    settledAt: '2026-09-14T22:27:00Z',
    sentAmount: '20.0000000',
    sentAsset: 'USDC',
    receivedAmount: '189.5359250',
    receivedAsset: 'XLM',
    hops: 0,
    kind: 'swap',
    fromThisApp: false,
    explorerUrl: 'https://stellar.expert/explorer/testnet/tx/tx111',
    ...over,
  }
}

function harness(ledger: SwapRecord[], existing: ChatTurn[] = []) {
  const written: ChatTurn[] = []
  return {
    written,
    options: {
      fetchHistory: (async () => ledger) as never,
      existing: () => existing,
      record: (t: ChatTurn) => void written.push(t),
    },
  }
}

const ME = 'GAJ74DIC3252BKBTDCEYTDA2ZYDRDBDT3QMZU5IW2HOZQBYVXMRZZEFA'

describe('trades the ledger has and the database does not', () => {
  it('writes a swap that history has never seen', async () => {
    const h = harness([record()])
    const result = await backfillFromLedger(ME, 'stellar', h.options)

    expect(result).toEqual({ found: 1, written: 1 })
    expect(h.written[0]?.txHash).toBe('tx111')
  })

  it('does not label a single transaction as a bundle', async () => {
    // Every backfilled row used to carry a one-step bundle, which made the
    // history panel name all of them "Bundled swap" — promising a second
    // transaction and a position link that do not exist. One transaction is a
    // swap; the ledger row carries its own explorer link.
    const h = harness([record()])
    await backfillFromLedger(ME, 'stellar', h.options)

    expect(h.written[0]?.bundle).toBeUndefined()
  })

  it('still identifies the transaction it recovered', async () => {
    const h = harness([record()])
    await backfillFromLedger(ME, 'stellar', h.options)

    expect(h.written[0]?.txHash).toBe('tx111')
  })

  it('dates the row when the trade settled, not when it was backfilled', async () => {
    // Ordering must match what actually happened, or a year-old trade appears
    // at the top of the list the moment it is recovered.
    const h = harness([record()])
    await backfillFromLedger(ME, 'stellar', h.options)

    expect(h.written[0]?.createdAt).toBe('2026-09-14T22:27:00Z')
  })

  it('says what the trade was, without inventing an instruction', async () => {
    // The user never typed anything for these. Phrasing the row as though they
    // had would put words in their history that they did not say.
    const h = harness([record()])
    await backfillFromLedger(ME, 'stellar', h.options)

    expect(h.written[0]?.text).toContain('20.0000000 USDC')
    expect(h.written[0]?.text).toContain('189.5359250 XLM')
  })

  it('names a resting order as one', async () => {
    const h = harness([record({ kind: 'limit' })])
    await backfillFromLedger(ME, 'stellar', h.options)

    expect(h.written[0]?.text).toContain('Limit order')
  })

  it('records trades made in other apps too', async () => {
    // A trade made elsewhere is still a trade this account made, and hiding it
    // would make the app's history disagree with the user's own ledger.
    const h = harness([record({ fromThisApp: false })])
    const result = await backfillFromLedger(ME, 'stellar', h.options)

    expect(result.written).toBe(1)
  })
})

describe('running it twice changes nothing', () => {
  it('skips a trade already backfilled', async () => {
    const already: ChatTurn = {
      id: 'onchain:tx111',
      chain: 'stellar',
      text: 'Swap: 20 USDC to 189 XLM',
      createdAt: '2026-09-14T22:27:00Z',
      proposals: {},
      winner: 'onchain',
      txHash: 'tx111',
    }
    const h = harness([record()], [already])
    const result = await backfillFromLedger(ME, 'stellar', h.options)

    expect(result).toEqual({ found: 1, written: 0 })
    expect(h.written).toHaveLength(0)
  })

  it('does not replace a turn the app recorded properly', async () => {
    // The one that matters. A recorded turn carries agent reasoning and a
    // bundle; the ledger can offer neither, so overwriting would lose the
    // substance of a competition to recover a row that already exists.
    const recorded: ChatTurn = {
      id: 'a-real-conversation',
      chain: 'stellar',
      text: 'Swap $500 worth of USDC to XLM and supply it to Blend',
      createdAt: '2026-09-14T22:27:00Z',
      proposals: {},
      winner: 'shadow',
      txHash: 'tx111',
      bundle: [
        { label: 'Swap', hash: 'tx111' },
        { label: 'Supply to Blend', hash: 'tx222', venue: 'Blend' },
      ],
    }
    const h = harness([record(), record({ txHash: 'tx222' })], [recorded])
    const result = await backfillFromLedger(ME, 'stellar', h.options)

    // Both ledger rows are already accounted for by the bundle.
    expect(result.written).toBe(0)
  })

  it('still writes a genuinely new trade alongside recorded ones', async () => {
    const recorded: ChatTurn = {
      id: 'a-real-conversation',
      chain: 'stellar',
      text: 'Buy $20 of XLM',
      createdAt: '2026-09-14T22:27:00Z',
      proposals: {},
      winner: 'shadow',
      txHash: 'tx111',
    }
    const h = harness([record(), record({ txHash: 'newtx' })], [recorded])
    const result = await backfillFromLedger(ME, 'stellar', h.options)

    expect(result.written).toBe(1)
    expect(h.written[0]?.txHash).toBe('newtx')
  })
})

describe('it never breaks the view it runs behind', () => {
  it('reports nothing when the ledger is unreachable', async () => {
    const result = await backfillFromLedger(ME, 'stellar', {
      fetchHistory: (() => Promise.reject(new Error('offline'))) as never,
      existing: () => [],
      record: () => undefined,
    })

    expect(result).toEqual({ found: 0, written: 0 })
  })

  it('does nothing on a chain with no ledger reader', async () => {
    // This reads Stellar's ledger specifically. Running it under Arc would
    // write Stellar trades into an Arc history.
    const h = harness([record()])
    const result = await backfillFromLedger(ME, 'arc', h.options)

    expect(result).toEqual({ found: 0, written: 0 })
    expect(h.written).toHaveLength(0)
  })
})
