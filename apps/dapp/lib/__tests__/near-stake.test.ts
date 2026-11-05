import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { nearModule } from '../chains/near/module'
import { confirmStake, metapoolVenue, rnearVenue } from '../chains/near/stake'
import { METAPOOL_CONTRACT, RNEAR_CONTRACT } from '../chains/near/tokens'
import { prepareChainAction } from '../chains/prepare'
import { ChainActionRefused, type ChainActionRequest, type NearTransaction } from '../chains/types'

const ME = 'alice.near'
const HASH = 'G6RQqbkHNF1JVMwmq9BiLnZ3vvUeYoNm7z4dYVEKgScA'

interface Rpc {
  views: Record<string, unknown>
  down: boolean
  tx: (() => unknown) | undefined
  apy: unknown
  apyDown: boolean
}

let rpc: Rpc

function install(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const json = (data: unknown): Response => new Response(JSON.stringify(data))
      if (url.endsWith('/get-rnear-apy')) {
        if (rpc.apyDown) throw new Error('down')
        return json({ code: 0, data: rpc.apy })
      }
      if (url.endsWith('/v0/tokens')) {
        return json([
          {
            assetId: 'nep141:wrap.near',
            decimals: 24,
            symbol: 'wNEAR',
            price: 4,
            priceUpdatedAt: new Date().toISOString(),
          },
        ])
      }
      if (rpc.down) throw new Error('down')
      const body = JSON.parse(init?.body as string) as {
        method: string
        params: { account_id?: string; method_name?: string }
      }
      if (body.method === 'tx') {
        const result = rpc.tx?.()
        return json(
          result === undefined ? { error: { cause: { name: 'UNKNOWN_TRANSACTION' } } } : { result }
        )
      }
      const key = `${body.params.account_id}.${body.params.method_name}`
      if (!(key in rpc.views)) return json({ result: { error: `no ${key}` } })
      return json({ result: { result: [...Buffer.from(JSON.stringify(rpc.views[key]))] } })
    })
  )
}

const stake = (over: Partial<ChainActionRequest> = {}): ChainActionRequest => ({
  kind: 'stake',
  amount: '2',
  tokenIn: 'NEAR',
  ...over,
})

function txOf(prepared: { signing: unknown }): NearTransaction {
  return (prepared.signing as { transactions: NearTransaction[] })
    .transactions[0] as NearTransaction
}

beforeEach(() => {
  rpc = {
    views: {
      [`${RNEAR_CONTRACT}.ft_price`]: '1000000000000000000000000',
      [`${RNEAR_CONTRACT}.is_paused`]: false,
      [`${RNEAR_CONTRACT}.storage_balance_of`]: null,
      [`${METAPOOL_CONTRACT}.get_st_near_price`]: '2000000000000000000000000',
      [`${METAPOOL_CONTRACT}.get_contract_params`]: {
        min_deposit_amount: '1000000000000000000000000',
      },
    },
    down: false,
    tx: undefined,
    apy: '4.588660',
    apyDown: false,
  }
  install()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('staking with rNEAR', () => {
  it('registers a new staker, then stakes, and passes its own check', async () => {
    const prepared = await rnearVenue.prepare(stake(), ME)
    const tx = txOf(prepared)
    expect(tx.receiverId).toBe('lst.rhealab.near')
    expect(tx.actions.map((a) => a.params.methodName)).toEqual([
      'storage_deposit',
      'deposit_and_stake',
    ])
    expect(tx.actions[1]?.params).toMatchObject({
      args: {},
      deposit: '2000000000000000000000000',
      gas: '200000000000000',
    })
    expect(prepared.receive).toEqual({ amount: '2', symbol: 'rNEAR', approximate: true })
    expect(() => rnearVenue.assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('skips registration when already registered', async () => {
    rpc.views[`${RNEAR_CONTRACT}.storage_balance_of`] = { total: '1', available: '0' }
    const prepared = await rnearVenue.prepare(stake(), ME)
    expect(txOf(prepared).actions.map((a) => a.params.methodName)).toEqual(['deposit_and_stake'])
    expect(prepared.notes.join(' ')).not.toMatch(/register/)
  })

  it('shows the rate from Rhea, and no rate if that fails', async () => {
    expect((await rnearVenue.prepare(stake(), ME)).apy).toEqual({ basePercent: 4.58866 })
    rpc.apyDown = true
    expect((await rnearVenue.prepare(stake(), ME)).apy).toBeUndefined()
    rpc.apyDown = false
    for (const bad of ['0', 'NaN', 'high', 5000, null]) {
      rpc.apy = bad
      expect((await rnearVenue.prepare(stake(), ME)).apy).toBeUndefined()
    }
  })

  it('names the link to Rhea Lend and promises no return', async () => {
    const notes = (await rnearVenue.prepare(stake(), ME)).notes.join(' ')
    expect(notes).toMatch(/Rhea Lend/)
    expect(notes).toMatch(/no return is guaranteed/)
  })

  it('refuses while paused, or when NEAR cannot be read', async () => {
    rpc.views[`${RNEAR_CONTRACT}.is_paused`] = true
    await expect(rnearVenue.prepare(stake(), ME)).rejects.toThrow(/paused/)
    rpc.down = true
    await expect(rnearVenue.prepare(stake(), ME)).rejects.toThrow(/could not be read/)
  })

  it('refuses a zero price rather than dividing by it', async () => {
    rpc.views[`${RNEAR_CONTRACT}.ft_price`] = '0'
    await expect(rnearVenue.prepare(stake(), ME)).rejects.toThrow(ChainActionRefused)
  })
})

describe('staking with Meta Pool', () => {
  it('sends one call, with no storage step, and passes its own check', async () => {
    const prepared = await metapoolVenue.prepare(stake(), ME)
    const tx = txOf(prepared)
    expect(tx.receiverId).toBe('meta-pool.near')
    expect(tx.actions).toEqual([
      {
        type: 'FunctionCall',
        params: {
          methodName: 'deposit_and_stake',
          args: {},
          gas: '100000000000000',
          deposit: '2000000000000000000000000',
        },
      },
    ])
    expect(prepared.receive).toEqual({ amount: '1', symbol: 'stNEAR', approximate: true })
    expect(prepared.apy).toBeUndefined()
    expect(() => metapoolVenue.assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('refuses below the minimum the contract reports', async () => {
    await expect(metapoolVenue.prepare(stake({ amount: '0.5' }), ME)).rejects.toThrow(
      /at least 1 NEAR/
    )
  })

  it('refuses when NEAR cannot be read', async () => {
    rpc.down = true
    await expect(metapoolVenue.prepare(stake(), ME)).rejects.toThrow(/could not be read/)
  })
})

describe('what both stake venues refuse', () => {
  it('refuses anything but NEAR, and any other kind of action', async () => {
    for (const venue of [rnearVenue, metapoolVenue]) {
      await expect(venue.prepare(stake({ tokenIn: 'USDC' }), ME)).rejects.toThrow(
        /only stakes NEAR/
      )
      await expect(venue.prepare(stake({ kind: 'swap' }), ME)).rejects.toThrow(ChainActionRefused)
      await expect(
        venue.prepare(stake(), 'GAJ74DIC3252BKBTDCEYTDA2ZYDRDBDT3QMZU5IW2HOZQBYVXMRZZEFA')
      ).rejects.toThrow(/not a NEAR account/)
    }
  })
})

describe('the module', () => {
  it('stakes with Meta Pool by default, and with rNEAR when named', async () => {
    await expect(prepareChainAction(nearModule, stake(), ME)).resolves.toMatchObject({
      venueId: 'metapool',
    })
    await expect(
      prepareChainAction(nearModule, stake({ venue: 'rNEAR' }), ME)
    ).resolves.toMatchObject({ venueId: 'rnear' })
    await expect(
      prepareChainAction(nearModule, stake({ venue: 'meta pool' }), ME)
    ).resolves.toMatchObject({ venueId: 'metapool' })
  })

  it('refuses a venue that cannot stake', async () => {
    await expect(prepareChainAction(nearModule, stake({ venue: '1click' }), ME)).rejects.toThrow(
      /can't stake here/
    )
  })

  it('has exactly the allowlisted tokens at the confirmed decimals', () => {
    expect(nearModule.tokens.map((t) => [t.symbol, t.id, t.decimals])).toEqual([
      ['NEAR', 'wrap.near', 24],
      ['USDC', '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', 6],
      ['USDT', 'usdt.tether-token.near', 6],
    ])
  })
})

describe('confirming a stake', () => {
  const executed =
    (status: unknown, over: Record<string, unknown> = {}): (() => unknown) =>
    () => ({
      status,
      transaction: {
        signer_id: ME,
        receiver_id: METAPOOL_CONTRACT,
        actions: [
          { FunctionCall: { method_name: 'deposit_and_stake', args: 'e30=', deposit: '1' } },
        ],
        ...over,
      },
    })

  async function run(over: { venueId?: string; hashes?: string[] } = {}) {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] })
    const pending = confirmStake({
      account: ME,
      venueId: over.venueId ?? 'metapool',
      signed: { family: 'near', hashes: over.hashes ?? [HASH] },
    })
    await vi.runAllTimersAsync()
    return pending
  }

  it('returns the hash and explorer link when the transaction succeeded', async () => {
    rpc.tx = executed({ SuccessValue: '' })
    await expect(run()).resolves.toEqual({
      ok: true,
      hash: HASH,
      explorerUrl: `https://nearblocks.io/txns/${HASH}`,
    })
  })

  it('says it failed in a plain sentence', async () => {
    rpc.tx = executed({ Failure: {} })
    const result = await run()
    expect(!result.ok && result.error).toMatch(/failed on NEAR.*came back/)
  })

  it('keeps polling through unknown, then succeeds', async () => {
    let seen = 0
    const done = executed({ SuccessValue: '' })
    rpc.tx = () => {
      seen += 1
      return seen < 3 ? undefined : done()
    }
    await expect(run()).resolves.toMatchObject({ ok: true })
    expect(seen).toBe(3)
  })

  it('reads an unfinished status as not yet confirmed', async () => {
    rpc.tx = executed('Started')
    const result = await run()
    expect(!result.ok && result.error).toMatch(/hasn't been confirmed yet.*Don't send it again/)
  })

  it('stops inside its bound and says so when never confirmed', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] })
    const startedAt = Date.now()
    const pending = confirmStake({
      account: ME,
      venueId: 'metapool',
      signed: { family: 'near', hashes: [HASH] },
    })
    await vi.runAllTimersAsync()
    const result = await pending
    expect(Date.now() - startedAt).toBeLessThan(30_000)
    expect(result.ok).toBe(false)
  })

  it('refuses a hash from another signer, another contract or another method', async () => {
    rpc.tx = executed({ SuccessValue: '' }, { signer_id: 'someone.near' })
    expect(await run()).toMatchObject({ ok: false })
    rpc.tx = executed({ SuccessValue: '' }, { receiver_id: 'evil.near' })
    expect(await run()).toMatchObject({ ok: false })
    rpc.tx = executed({ SuccessValue: '' }, { actions: [] })
    expect(await run()).toMatchObject({ ok: false })
    rpc.tx = executed({ SuccessValue: '' })
    expect(await run({ venueId: 'rnear' })).toMatchObject({ ok: false })
  })

  it('refuses an unknown venue and bad hashes', async () => {
    expect(await run({ venueId: 'constructor' })).toMatchObject({ ok: false })
    expect(await run({ hashes: ['not a hash'] })).toMatchObject({ ok: false })
    expect(await run({ hashes: [] })).toMatchObject({ ok: false })
  })
})
