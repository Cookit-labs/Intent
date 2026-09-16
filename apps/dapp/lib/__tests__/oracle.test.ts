import {
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { isStale, readOracleMeta, readPrice, readPriceFor, type OracleAsset } from '../lend/oracle'

/**
 * The SEP-40 client, without a network.
 *
 * The thing most worth pinning is not the parsing but the *argument shape*.
 * Blend's oracle names assets as `Stellar(contract)`; Reflector names them as
 * `Other("XLM")`. Send one oracle the other's form and it answers `null` — not
 * an error, not a type complaint, just no price. That is exactly the failure a
 * fixture-based test built on this module's own encoding would never see, so
 * these tests decode what the client actually put on the wire.
 */

const ORACLE = 'CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63'
const XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

type Sim = Pick<rpc.Server, 'simulateTransaction'>

/**
 * The decoded contract call inside a built transaction.
 *
 * On the SDK's decoded `Operation`, `func.invokeContract` is a plain property
 * holding `functionName` and `args` — not a method. This mirrors how
 * `assertSelfPoolCall` in blend-client.ts reads the same structure.
 */
function invocationOf(tx: Parameters<Sim['simulateTransaction']>[0]): {
  functionName?: unknown
  args?: xdr.ScVal[]
} {
  const op = (tx as { operations: Operation[] }).operations[0] as
    | { func?: { invokeContract?: { functionName?: unknown; args?: xdr.ScVal[] } } }
    | undefined
  return op?.func?.invokeContract ?? {}
}

function argsOf(tx: Parameters<Sim['simulateTransaction']>[0]): xdr.ScVal[] {
  return invocationOf(tx).args ?? []
}

function fnOf(tx: Parameters<Sim['simulateTransaction']>[0]): string {
  return String(invocationOf(tx).functionName ?? '')
}

/**
 * A fake oracle that records every call and answers from a table.
 *
 * `lastprice` answers only when the asset argument matches `expects`, so a
 * test can assert not just that a price came back but that it came back for
 * the *right encoding* — the wrong arm gets `null`, as the real oracles do.
 */
function fakeOracle(opts: {
  decimals?: number
  resolution?: number
  lastTimestamp?: number
  expects?: OracleAsset
  price?: bigint
}): Sim & { calls: string[]; seenArgs: xdr.ScVal[][] } {
  const calls: string[] = []
  const seenArgs: xdr.ScVal[][] = []

  function matches(arg: xdr.ScVal | undefined): boolean {
    if (arg === undefined || opts.expects === undefined) return false
    const native = scValToNative(arg) as unknown
    if (!Array.isArray(native) || native.length !== 2) return false
    const [arm, value] = native as [string, string]
    if (opts.expects.kind === 'stellar') return arm === 'Stellar' && value === opts.expects.contract
    return arm === 'Other' && value === opts.expects.symbol
  }

  return {
    calls,
    seenArgs,
    async simulateTransaction(tx) {
      const fn = fnOf(tx)
      const args = argsOf(tx)
      calls.push(fn)
      seenArgs.push(args)

      let retval: xdr.ScVal
      switch (fn) {
        case 'decimals':
          retval = nativeToScVal(opts.decimals ?? 14, { type: 'u32' })
          break
        case 'resolution':
          retval = nativeToScVal(opts.resolution ?? 300, { type: 'u32' })
          break
        case 'last_timestamp':
          retval = nativeToScVal(BigInt(opts.lastTimestamp ?? 1_000_000), { type: 'u64' })
          break
        case 'lastprice':
          retval = matches(args[0])
            ? nativeToScVal(
                {
                  price: opts.price ?? BigInt(17979762484866),
                  timestamp: BigInt(opts.lastTimestamp ?? 1_000_000),
                },
                { type: { price: ['symbol', 'i128'], timestamp: ['symbol', 'u64'] } }
              )
            : xdr.ScVal.scvVoid()
          break
        default:
          retval = xdr.ScVal.scvVoid()
      }

      // The client reads `result.retval` and asks `isSimulationError`, which
      // only checks for an `error` key. Nothing else in the response is
      // consulted, so nothing else is faked — a fuller fake would only pin
      // fields the code under test never touches.
      return {
        id: '1',
        latestLedger: 1,
        events: [],
        minResourceFee: '0',
        result: { auth: [], retval },
      } as unknown as rpc.Api.SimulateTransactionSuccessResponse
    },
  }
}

describe('naming an asset in either enum arm', () => {
  it('encodes Stellar(contract) as a two-element vec with a symbol and an address', async () => {
    const oracle = fakeOracle({ expects: { kind: 'stellar', contract: XLM_SAC } })

    const price = await readPriceFor(
      { kind: 'stellar', contract: XLM_SAC },
      { oracleId: ORACLE, serverImpl: oracle }
    )

    expect(price).toBeDefined()
    const arg = oracle.seenArgs[oracle.calls.indexOf('lastprice')]?.[0]
    expect(scValToNative(arg as xdr.ScVal)).toEqual(['Stellar', XLM_SAC])
  })

  it('encodes Other(symbol) as a two-element vec with two symbols', async () => {
    const oracle = fakeOracle({ expects: { kind: 'other', symbol: 'XLM' } })

    const price = await readPriceFor(
      { kind: 'other', symbol: 'XLM' },
      { oracleId: ORACLE, serverImpl: oracle }
    )

    expect(price).toBeDefined()
    const arg = oracle.seenArgs[oracle.calls.indexOf('lastprice')]?.[0]
    expect(scValToNative(arg as xdr.ScVal)).toEqual(['Other', 'XLM'])
  })

  it('gets nothing back when it sends an oracle the wrong arm', async () => {
    // This is the failure Reflector and Blend actually produce for each
    // other's form: `null`, not an error. A client that assumed one arm would
    // pass every test it wrote against its own encoding and still read no
    // prices from the other oracle.
    const reflectorLike = fakeOracle({ expects: { kind: 'other', symbol: 'XLM' } })

    const price = await readPrice(XLM_SAC, { oracleId: ORACLE, serverImpl: reflectorLike })

    expect(price).toBeUndefined()
  })

  it('keeps readPrice on the Stellar arm for the position reader', async () => {
    const blendLike = fakeOracle({ expects: { kind: 'stellar', contract: XLM_SAC } })

    const price = await readPrice(XLM_SAC, { oracleId: ORACLE, serverImpl: blendLike })

    expect(price?.price).toBe(BigInt(17979762484866))
  })
})

describe('reading the oracle about itself', () => {
  it('reads decimals at runtime rather than assuming them', async () => {
    // Reflector says 14, Blend's mock says 7. A hardcoded either is a 10^7
    // error that still looks like a price.
    const meta = await readOracleMeta(ORACLE, {
      serverImpl: fakeOracle({ decimals: 14, resolution: 300, lastTimestamp: 1789599900 }),
    })

    expect(meta.decimals).toBe(14)
    expect(meta.resolution).toBe(300)
    expect(meta.lastTimestamp).toBe(1789599900)
  })

  it('carries decimals on every price it returns', async () => {
    const price = await readPriceFor(
      { kind: 'other', symbol: 'XLM' },
      {
        oracleId: ORACLE,
        serverImpl: fakeOracle({ decimals: 14, expects: { kind: 'other', symbol: 'XLM' } }),
      }
    )

    expect(price?.decimals).toBe(14)
  })
})

describe('whether a price is too old to act on', () => {
  const meta = { resolution: 300 }

  it('is fresh within one period', () => {
    expect(isStale({ timestamp: 1000 }, meta, 1000 + 299)).toBe(false)
  })

  it('is still fresh after one missed period — ordinary jitter', () => {
    expect(isStale({ timestamp: 1000 }, meta, 1000 + 600)).toBe(false)
  })

  it('is stale once a second period has been missed', () => {
    expect(isStale({ timestamp: 1000 }, meta, 1000 + 601)).toBe(true)
  })

  it('judges by the oracle cadence, not a fixed number of seconds', () => {
    // An hourly feed 40 minutes old is fine; a five-minute feed 40 minutes
    // old is dead. The same age, opposite answers.
    expect(isStale({ timestamp: 1000 }, { resolution: 3600 }, 1000 + 2400)).toBe(false)
    expect(isStale({ timestamp: 1000 }, { resolution: 300 }, 1000 + 2400)).toBe(true)
  })

  it('never calls a price stale when the oracle reports no cadence', () => {
    expect(isStale({ timestamp: 0 }, { resolution: 0 }, 10_000_000)).toBe(false)
  })
})

// Keep the import used: TransactionBuilder is what the client builds with,
// and pulling it in here guards against the SDK surface drifting under us.
void TransactionBuilder
