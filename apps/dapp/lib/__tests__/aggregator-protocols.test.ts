import { Address, xdr, type rpc } from '@stellar/stellar-sdk'
import { afterEach, describe, expect, it } from 'vitest'

import {
  resetAggregatorProtocolCache,
  resolveAggregatorProtocols,
} from '../swap/aggregator-protocols'
import { AQUARIUS_ROUTER, SOROSWAP_AGGREGATOR, SOROSWAP_ROUTER } from '../swap/contract-registry'

/**
 * Which venues the aggregator may be asked to route through.
 *
 * The API accepts `phoenix` in every request and its committed address file
 * lists a Phoenix adapter for testnet. Simulating `get_adapters()` on the
 * live aggregator on 2026-09-23 returned three unpaused adapters — protocol
 * 0 at Soroswap's router, 1 at `CBAMPJ…FTOC`, 2 at Aquarius's router — and a
 * ledger read of the second found no contract at all. A quote through it can
 * come back priced; the swap fails at execution. So the list is built from
 * what the contract says and what the ledger confirms, never from a file,
 * and `phoenix` is refused by policy even on the day its adapter reappears.
 */

/** The Phoenix adapter the aggregator names, which the ledger does not have. */
const PHOENIX_DEAD = 'CBAMPJTMNDXBBYYQ77C7WX2MTBR3XZHERDJ7NQMXLEZHMWUFQBQMFTOC'
/** A well-formed id standing in for a Comet adapter. */
const COMET = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

interface Adapter {
  protocol_id: number
  router: string
  paused: boolean
}

/** An `Adapter` struct as the contract encodes it: a map with sorted symbol keys. */
function adapterVal(a: Adapter): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('paused'), val: xdr.ScVal.scvBool(a.paused) }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('protocol_id'),
      val: xdr.ScVal.scvU32(a.protocol_id),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('router'),
      val: new Address(a.router).toScVal(),
    }),
  ])
}

type FakeServer = Pick<rpc.Server, 'simulateTransaction' | 'getContractData'> & {
  simulations: number
  probes: string[]
}

/**
 * An RPC that answers `get_adapters()` with a fixed list and knows which
 * adapter contracts exist on its ledger.
 */
function fakeServer(adapters: Adapter[] | 'error' | 'throw', missing: string[] = []): FakeServer {
  const server: FakeServer = {
    simulations: 0,
    probes: [],
    simulateTransaction: (async () => {
      server.simulations += 1
      if (adapters === 'throw') throw new Error('ECONNRESET')
      if (adapters === 'error') return { error: 'HostError: contract not found', id: '1' }
      return {
        id: '1',
        latestLedger: 1,
        result: { retval: xdr.ScVal.scvVec(adapters.map(adapterVal)), auth: [] },
      }
    }) as unknown as rpc.Server['simulateTransaction'],
    getContractData: (async (id: string) => {
      server.probes.push(id)
      if (missing.includes(id)) throw new Error(`Contract data not found for ${id}`)
      return {}
    }) as unknown as rpc.Server['getContractData'],
  }
  return server
}

const LIVE: Adapter[] = [
  { protocol_id: 0, router: SOROSWAP_ROUTER, paused: false },
  { protocol_id: 1, router: PHOENIX_DEAD, paused: false },
  { protocol_id: 2, router: AQUARIUS_ROUTER, paused: false },
]

afterEach(() => resetAggregatorProtocolCache())

describe('the protocol list is read from the contract and the ledger', () => {
  it('offers the adapters that exist, plus the classic DEX', async () => {
    const server = fakeServer(LIVE, [PHOENIX_DEAD])

    const got = await resolveAggregatorProtocols({
      aggregatorId: SOROSWAP_AGGREGATOR,
      serverImpl: server,
    })

    expect(got?.protocols).toEqual(['soroswap', 'aqua', 'sdex'])
    // Every adapter was checked against the ledger, not taken on trust.
    expect(server.probes).toEqual([SOROSWAP_ROUTER, PHOENIX_DEAD, AQUARIUS_ROUTER])
    expect(got?.adapters.find((a) => a.protocol === 'phoenix')?.deployed).toBe(false)
  })

  it('never offers a protocol the app has not allowed, even with a live adapter', async () => {
    // The day Phoenix's adapter reappears, or Comet's is added, neither is
    // offered until somebody has verified a swap through it. A whitelist that
    // grew on its own would be the committed address file all over again.
    const server = fakeServer([...LIVE, { protocol_id: 3, router: COMET, paused: false }])

    const got = await resolveAggregatorProtocols({
      aggregatorId: SOROSWAP_AGGREGATOR,
      serverImpl: server,
    })

    expect(got?.protocols).toEqual(['soroswap', 'aqua', 'sdex'])
  })

  it('drops an adapter the aggregator has paused', async () => {
    const server = fakeServer(
      [
        { protocol_id: 0, router: SOROSWAP_ROUTER, paused: false },
        { protocol_id: 2, router: AQUARIUS_ROUTER, paused: true },
      ],
      []
    )

    const got = await resolveAggregatorProtocols({
      aggregatorId: SOROSWAP_AGGREGATOR,
      serverImpl: server,
    })

    expect(got?.protocols).toEqual(['soroswap', 'sdex'])
  })

  it('reports nothing when the adapters cannot be read', async () => {
    // No adapters means no whitelist, and no whitelist means no quote. The
    // alternative — falling back to a hardcoded list — is exactly the file
    // this exists to replace.
    const got = await resolveAggregatorProtocols({
      aggregatorId: SOROSWAP_AGGREGATOR,
      serverImpl: fakeServer('error'),
    })

    expect(got).toBeUndefined()
  })

  it('never throws when the RPC is unreachable', async () => {
    await expect(
      resolveAggregatorProtocols({
        aggregatorId: SOROSWAP_AGGREGATOR,
        serverImpl: fakeServer('throw'),
      })
    ).resolves.toBeUndefined()
  })
})

describe('the answer is cached', () => {
  it('simulates once within the TTL and again after it', async () => {
    let now = 5_000_000
    const server = fakeServer(LIVE, [PHOENIX_DEAD])
    const options = {
      aggregatorId: SOROSWAP_AGGREGATOR,
      serverImpl: server,
      now: () => now,
      ttlMs: 60_000,
    }

    await resolveAggregatorProtocols(options)
    await resolveAggregatorProtocols(options)
    expect(server.simulations).toBe(1)

    now += 60_001
    await resolveAggregatorProtocols(options)
    expect(server.simulations).toBe(2)
  })

  it('does not cache a failure', async () => {
    const failing = fakeServer('error')
    const working = fakeServer(LIVE, [PHOENIX_DEAD])

    expect(
      await resolveAggregatorProtocols({ aggregatorId: SOROSWAP_AGGREGATOR, serverImpl: failing })
    ).toBeUndefined()
    const got = await resolveAggregatorProtocols({
      aggregatorId: SOROSWAP_AGGREGATOR,
      serverImpl: working,
    })

    expect(got?.protocols).toEqual(['soroswap', 'aqua', 'sdex'])
    expect(working.simulations).toBe(1)
  })
})
