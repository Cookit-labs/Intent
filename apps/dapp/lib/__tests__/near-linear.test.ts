import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { chainHelp } from '../chains/explain'
import { nearCapabilities } from '../chains/near/capabilities'
import { nearModule } from '../chains/near/module'
import { confirmStake, linearVenue } from '../chains/near/stake'
import { LINEAR_CONTRACT, nearTokens } from '../chains/near/tokens'
import { nearVenues } from '../chains/near/venues'
import { parseChainAction } from '../chains/parse-action'
import { prepareChainAction } from '../chains/prepare'
import { ChainActionRefused, type ChainActionRequest, type NearTransaction } from '../chains/types'
import type { NearFunctionCall } from '../chains/types'

const ME = 'alice.near'
const HASH = 'G6RQqbkHNF1JVMwmq9BiLnZ3vvUeYoNm7z4dYVEKgScA'
const ONE = '1000000000000000000000000'

let views: Record<string, unknown>
let down: boolean
let balance: string
let tx: unknown

beforeEach(() => {
  views = {
    [`${LINEAR_CONTRACT}.ft_price`]: '1430564336225844746301435',
    [`${LINEAR_CONTRACT}.is_paused`]: false,
    [`${LINEAR_CONTRACT}.storage_balance_of`]: null,
    [`${LINEAR_CONTRACT}.ft_balance_of`]: '0',
    [`${LINEAR_CONTRACT}.get_account_details`]: {
      unstaked_balance: '0',
      unstaked_available_epoch_height: 0,
      can_withdraw: true,
    },
    'meta-pool.near.get_contract_state': { env_epoch_height: '3000' },
  }
  down = false
  balance = `5${'0'.repeat(25)}`
  tx = undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const json = (data: unknown): Response => new Response(JSON.stringify(data))
      if (down) throw new Error('down')
      const body = JSON.parse(init?.body as string) as {
        method: string
        params: { request_type?: string; account_id?: string; method_name?: string }
      }
      if (body.method === 'tx') {
        return json(
          tx === undefined ? { error: { cause: { name: 'UNKNOWN_TRANSACTION' } } } : { result: tx }
        )
      }
      if (body.params.request_type === 'view_account') {
        return json({ result: { amount: balance, locked: '0', storage_usage: 0 } })
      }
      const key = `${body.params.account_id}.${body.params.method_name}`
      if (!(key in views)) return json({ result: { error: `no ${key}` } })
      return json({ result: { result: [...Buffer.from(JSON.stringify(views[key]))] } })
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const ask = (over: Partial<ChainActionRequest> = {}): ChainActionRequest => ({
  kind: 'stake',
  amount: '2',
  tokenIn: 'NEAR',
  ...over,
})

const txOf = (prepared: { signing: unknown }): NearTransaction =>
  (prepared.signing as { transactions: NearTransaction[] }).transactions[0] as NearTransaction

const methods = (prepared: { signing: unknown }): string[] =>
  txOf(prepared).actions.map((a) => (a as NearFunctionCall).params.methodName)

describe('staking with LiNEAR', () => {
  it('registers a new staker, stakes on linear-protocol.near, and passes its own check', async () => {
    const prepared = await linearVenue.prepare(ask(), ME)
    expect(txOf(prepared).receiverId).toBe('linear-protocol.near')
    expect(methods(prepared)).toEqual(['storage_deposit', 'deposit_and_stake'])
    expect((txOf(prepared).actions[1] as NearFunctionCall).params).toMatchObject({
      args: {},
      deposit: `2${'0'.repeat(24)}`,
    })
    expect(prepared.receive).toMatchObject({ symbol: 'LiNEAR', approximate: true })
    expect(Number(prepared.receive?.amount)).toBeCloseTo(2 / 1.430564336225844746301435, 5)
    expect(prepared.apy).toBeUndefined()
    expect(() => linearVenue.assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('skips registration when already registered', async () => {
    views[`${LINEAR_CONTRACT}.storage_balance_of`] = { total: '1', available: '0' }
    expect(methods(await linearVenue.prepare(ask(), ME))).toEqual(['deposit_and_stake'])
  })

  it('promises no return and says how long leaving takes', async () => {
    const notes = (await linearVenue.prepare(ask(), ME)).notes.join(' ')
    expect(notes).toMatch(/no return is guaranteed/)
    expect(notes).toMatch(/4 epochs/)
  })

  it('refuses while paused, or when NEAR cannot be read', async () => {
    views[`${LINEAR_CONTRACT}.is_paused`] = true
    await expect(linearVenue.prepare(ask(), ME)).rejects.toThrow(/paused/)
    down = true
    await expect(linearVenue.prepare(ask(), ME)).rejects.toThrow(/could not be read/)
  })

  it('refuses a transaction to another contract', async () => {
    const prepared = await linearVenue.prepare(ask(), ME)
    const moved = {
      ...(prepared.signing as object),
      transactions: [{ ...txOf(prepared), receiverId: 'lst.rhealab.near' }],
    }
    expect(() => linearVenue.assertSafe(moved as never, ME)).toThrow()
  })
})

describe('leaving LiNEAR', () => {
  it('unstakes the NEAR worth of the LiNEAR asked for', async () => {
    views[`${LINEAR_CONTRACT}.ft_balance_of`] = `3${'0'.repeat(24)}`
    const prepared = await linearVenue.prepare(
      ask({ kind: 'unstake', tokenIn: 'LiNEAR', amount: '1' }),
      ME
    )
    expect(methods(prepared)).toEqual(['unstake'])
    expect((txOf(prepared).actions[0] as NearFunctionCall).params.args).toEqual({
      amount: '1430564336225844746301435',
    })
    expect(prepared.pay).toEqual({ amount: '1', symbol: 'LiNEAR' })
    expect(() => linearVenue.assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('unstakes everything with unstake_all', async () => {
    views[`${LINEAR_CONTRACT}.ft_balance_of`] = `3${'0'.repeat(24)}`
    const prepared = await linearVenue.prepare(
      ask({ kind: 'unstake', tokenIn: 'LINEAR', amount: '3', wholePosition: true }),
      ME
    )
    expect(methods(prepared)).toEqual(['unstake_all'])
  })

  it('refuses to unstake more than is held', async () => {
    views[`${LINEAR_CONTRACT}.ft_balance_of`] = ONE
    await expect(
      linearVenue.prepare(ask({ kind: 'unstake', tokenIn: 'LiNEAR', amount: '2' }), ME)
    ).rejects.toThrow(ChainActionRefused)
  })

  it('claims with withdraw_all once the wait is over and the contract can pay', async () => {
    views[`${LINEAR_CONTRACT}.get_account_details`] = {
      unstaked_balance: ONE,
      unstaked_available_epoch_height: 2990,
      can_withdraw: true,
    }
    const prepared = await linearVenue.prepare(
      ask({ kind: 'claim', tokenIn: 'NEAR', amount: '1' }),
      ME
    )
    expect(methods(prepared)).toEqual(['withdraw_all'])
    expect(() => linearVenue.assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('says when an unstake will be ready instead of building a claim too early', async () => {
    views[`${LINEAR_CONTRACT}.get_account_details`] = {
      unstaked_balance: ONE,
      unstaked_available_epoch_height: 3002,
      can_withdraw: false,
    }
    await expect(
      linearVenue.prepare(ask({ kind: 'claim', tokenIn: 'NEAR', amount: '1' }), ME)
    ).rejects.toThrow(/about 15 hours/)
  })

  it('shows staked, cooling and claimable positions', async () => {
    views[`${LINEAR_CONTRACT}.ft_balance_of`] = ONE
    views[`${LINEAR_CONTRACT}.get_account_details`] = {
      unstaked_balance: ONE,
      unstaked_available_epoch_height: 3002,
      can_withdraw: false,
    }
    expect(await linearVenue.positions?.(ME)).toEqual([
      { slot: 'staked', symbol: 'LiNEAR', amount: '1' },
      { slot: 'cooling', symbol: 'NEAR', amount: '1', readyInHours: 15 },
    ])
  })
})

describe('LiNEAR from what the person types', () => {
  it('stakes with LiNEAR when the message names it', async () => {
    const request = parseChainAction('stake 2 NEAR with LiNEAR')
    expect(request).toMatchObject({ kind: 'stake', tokenIn: 'NEAR', venue: 'LiNEAR' })
    const prepared = await prepareChainAction(nearModule, request as ChainActionRequest, ME)
    expect(prepared.venueId).toBe('linear')
  })

  it('sends "unstake 1 LiNEAR" to LiNEAR without naming the venue', async () => {
    views[`${LINEAR_CONTRACT}.ft_balance_of`] = `3${'0'.repeat(24)}`
    const request = parseChainAction('unstake 1 LiNEAR')
    const prepared = await prepareChainAction(nearModule, request as ChainActionRequest, ME)
    expect(prepared.venueId).toBe('linear')
  })

  it('offers it in the help text', () => {
    expect(chainHelp('NEAR', nearCapabilities)).toContain('"stake 1 NEAR with LiNEAR"')
  })
})

describe('LiNEAR in the NEAR module', () => {
  it('stakes with LiNEAR when named, and routes LiNEAR exits to it', async () => {
    const prepared = await prepareChainAction(nearModule, { ...ask(), venue: 'linear' }, ME)
    expect(prepared.venueId).toBe('linear')
    expect(nearModule.venueForToken?.unstake?.['LINEAR']).toBe('linear')
  })

  it('lists the token, the venue and what it can do', () => {
    expect(nearTokens.find((t) => t.symbol === 'LiNEAR')).toEqual({
      symbol: 'LiNEAR',
      id: 'linear-protocol.near',
      decimals: 24,
      name: 'LiNEAR',
    })
    expect(nearVenues.some((v) => v.id === 'linear' && v.integration === 'executes')).toBe(true)
    expect(nearCapabilities).toEqual(
      expect.arrayContaining([
        { kind: 'stake', venue: 'LiNEAR', symbol: 'NEAR' },
        { kind: 'unstake', venue: 'LiNEAR', symbol: 'LiNEAR' },
      ])
    )
  })

  it("confirms only this account's call to LiNEAR", async () => {
    tx = {
      status: { SuccessValue: '' },
      transaction: {
        signer_id: ME,
        receiver_id: LINEAR_CONTRACT,
        actions: [
          { FunctionCall: { method_name: 'deposit_and_stake', args: '', gas: 1, deposit: '1' } },
        ],
      },
      receipts_outcome: [],
    }
    const signed = { family: 'near' as const, hashes: [HASH] }
    expect(await confirmStake({ account: ME, venueId: 'linear', signed } as never)).toMatchObject({
      ok: true,
      hash: HASH,
    })
  })
})
