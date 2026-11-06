import { afterEach, describe, expect, it, vi } from 'vitest'

import { earnVenue } from '../chains/near/earn'
import { clearTokenCache, requestQuote } from '../chains/near/oneclick'
import { viewCall } from '../chains/near/rpc'
import { INTENTS_CONTRACT } from '../chains/near/safety'
import { metapoolVenue, rnearVenue } from '../chains/near/stake'
import { METAPOOL_CONTRACT, RNEAR_CONTRACT, USDC_NEAR } from '../chains/near/tokens'

/**
 * The real contracts and 1Click, read-only. Nothing signs or sends, and what gets built is never
 * given to a wallet. NEAR has no way to simulate a change call, so a payload's method and argument
 * names are held against the contract's own exports and the ABI it reports.
 *
 * `ONECLICK_LIVE_ADDRESS=1` also runs the one test that asks for a real deposit address. It moves
 * nothing, but it leaves a record at 1Click, so it doesn't run by default.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const RPC = process.env['NEAR_RPC_URL'] ?? 'https://free.rpc.fastnear.com'
const VAULT = 'nep141:base-0x0bb69b79bc829e1cfcc34a740110886d98d2bd14.omft.near'
const USDC = `nep141:${USDC_NEAR}`

async function code(contract: string): Promise<string[]> {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'test',
      method: 'query',
      params: { request_type: 'view_code', finality: 'final', account_id: contract },
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await response.json()) as { result: { code_base64: string } }
  const bytes = Buffer.from(body.result.code_base64, 'base64')
  let at = 8
  const leb = (): number => {
    let value = 0
    let shift = 0
    let byte: number
    do {
      byte = bytes[at] as number
      at += 1
      value |= (byte & 0x7f) << shift
      shift += 7
    } while (byte & 0x80)
    return value >>> 0
  }
  while (at < bytes.length) {
    const section = bytes[at] as number
    at += 1
    const end = leb() + at
    if (section === 7) {
      const names: string[] = []
      const count = leb()
      for (let i = 0; i < count; i += 1) {
        const size = leb()
        names.push(bytes.subarray(at, at + size).toString())
        at += size + 1
        leb()
      }
      return names
    }
    at = end
  }
  return []
}

afterEach(() => {
  vi.unstubAllGlobals()
  clearTokenCache()
})

describe.skipIf(SKIP)('the exit methods on the deployed contracts', () => {
  it.each([
    [
      METAPOOL_CONTRACT,
      ['unstake', 'unstake_all', 'withdraw_unstaked', 'get_account_info', 'get_contract_state'],
    ],
    [
      RNEAR_CONTRACT,
      ['unstake', 'unstake_all', 'withdraw_all', 'get_account_details', 'ft_balance_of'],
    ],
    [INTENTS_CONTRACT, ['mt_transfer', 'ft_withdraw', 'mt_balance_of']],
  ])(
    '%s exports what this app calls',
    async (contract, methods) => {
      const exported = await code(contract)
      for (const method of methods) expect(exported, method).toContain(method)
    },
    60_000
  )

  it('reports the Meta Pool delay as a number of epochs', async () => {
    const epochs = await viewCall<number>(METAPOOL_CONTRACT, 'compute_current_unstaking_delay', {
      amount: '1000000000000000000000000',
    })
    expect([4, 8]).toContain(epochs)
  }, 30_000)

  it('leaves a new account able to use the Intents exit without a signed message', async () => {
    await expect(
      viewCall<boolean>(INTENTS_CONTRACT, 'is_auth_by_predecessor_id_enabled', {
        account_id: 'root.near',
      })
    ).resolves.toBe(true)
  }, 30_000)
})

describe.skipIf(SKIP)('a real holder', () => {
  it('reads Meta Pool, builds both unstakes and passes its own check', async () => {
    const positions = await metapoolVenue.positions?.('root.near')
    const staked = positions?.find((p) => p.slot === 'staked')
    expect(staked?.symbol).toBe('stNEAR')
    expect(Number(staked?.amount)).toBeGreaterThan(0)

    const whole = await metapoolVenue.prepare(
      {
        kind: 'unstake',
        amount: staked?.amount ?? '0',
        tokenIn: 'stNEAR',
        wholePosition: true,
      },
      'root.near'
    )
    expect(() => metapoolVenue.assertSafe(whole.signing, 'root.near')).not.toThrow()
    const part = await metapoolVenue.prepare(
      { kind: 'unstake', amount: '0.1', tokenIn: 'stNEAR' },
      'root.near'
    )
    expect(() => metapoolVenue.assertSafe(part.signing, 'root.near')).not.toThrow()
    expect(Number(part.receive?.amount)).toBeGreaterThan(0.1)
    expect(part.notes.join(' ')).toMatch(/(4|8) epochs/)
  }, 60_000)

  it('reads rNEAR from the first accounts that hold some, and builds their exit', async () => {
    const accounts = await viewCall<
      { account_id: string; staked_balance: string; unstaked_balance: string }[]
    >(RNEAR_CONTRACT, 'get_accounts', { from_index: 0, limit: 40 })
    const holder = accounts.find((a) => BigInt(a.staked_balance) > BigInt(0))
    if (holder === undefined) throw new Error('no holder in the first accounts')

    const positions = await rnearVenue.positions?.(holder.account_id)
    expect(positions?.find((p) => p.slot === 'staked')?.symbol).toBe('rNEAR')
    const whole = await rnearVenue.prepare(
      { kind: 'unstake', amount: '1', tokenIn: 'rNEAR', wholePosition: true },
      holder.account_id
    )
    expect(() => rnearVenue.assertSafe(whole.signing, holder.account_id)).not.toThrow()
  }, 60_000)

  it('reads a real unstake on its way at each venue, and builds or refuses its claim', async () => {
    const venues = [
      { venue: metapoolVenue, contract: METAPOOL_CONTRACT },
      { venue: rnearVenue, contract: RNEAR_CONTRACT },
    ]
    for (const { venue, contract } of venues) {
      const pending: { account_id: string; unstaked_balance: string }[] = []
      for (let from = 0; from < 2000 && pending.length === 0; from += 100) {
        const page = await viewCall<{ account_id: string; unstaked_balance: string }[]>(
          contract,
          'get_accounts',
          { from_index: from, limit: 100 }
        )
        pending.push(
          ...page.filter((a) => BigInt(a.unstaked_balance) > BigInt('1000000000000000000000'))
        )
      }
      const account = pending[0]?.account_id
      if (account === undefined) throw new Error(`no pending unstake found on ${contract}`)

      const positions = await venue.positions?.(account)
      const waiting = positions?.find((p) => p.slot === 'claimable' || p.slot === 'cooling')
      expect(waiting?.symbol, contract).toBe('NEAR')
      const claim = { kind: 'claim', amount: 'all', tokenIn: 'NEAR' } as const
      if (waiting?.slot === 'claimable') {
        const prepared = await venue.prepare(claim, account)
        expect(() => venue.assertSafe(prepared.signing, account)).not.toThrow()
      } else {
        await expect(venue.prepare(claim, account)).rejects.toThrow(/isn't ready yet/)
      }
    }
  }, 120_000)

  it('reads Earn positions from the chain for an account with none', async () => {
    await expect(earnVenue.positions?.('root.near')).resolves.toEqual([])
  }, 30_000)
})

describe.skipIf(SKIP)('selling a vault share through 1Click', () => {
  it('quotes it from the balance to the balance, signed by 1Click', async () => {
    const envelope = await requestQuote({
      dry: true,
      originAsset: VAULT,
      destinationAsset: USDC,
      amount: '90000000000000000000000000',
      account: 'root.near',
      recipientType: 'INTENTS',
      deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
      slippageBps: 100,
      fromIntents: true,
    })
    expect(envelope.quoteRequest).toMatchObject({
      depositType: 'INTENTS',
      refundType: 'INTENTS',
      recipientType: 'INTENTS',
      refundTo: 'root.near',
    })
    expect(BigInt(envelope.quote.amountOut)).toBeGreaterThan(BigInt(0))
    const loss = 1 - Number(envelope.quote.amountOutUsd) / Number(envelope.quote.amountInUsd)
    expect(loss).toBeLessThan(0.05)
  }, 45_000)

  it('builds a real sale for a pretend balance, whose address passes the check', async () => {
    if (process.env['ONECLICK_LIVE_ADDRESS'] !== '1') return
    const real = globalThis.fetch
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : ''
      if (body.includes('"mt_balance_of"')) {
        const shares = JSON.stringify('90000000000000000000000000')
        return new Response(JSON.stringify({ result: { result: [...Buffer.from(shares)] } }), {
          status: 200,
        })
      }
      return real(input, init)
    })
    const prepared = await earnVenue.prepare(
      { kind: 'withdraw', amount: '100', tokenIn: 'USDC', wholePosition: true },
      'root.near'
    )
    expect(() => earnVenue.assertSafe(prepared.signing, 'root.near')).not.toThrow()
    expect(prepared.context?.['depositAddress']).toMatch(/^[0-9a-f]{64}$/)
  }, 60_000)
})
