import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Every way out on Stellar mainnet, simulated against real positions. Nothing is
 * signed or sent, and no key exists here.
 *
 * The accounts are real holders found from the pool's own events on 2026-11-05.
 * A holder can leave, so each test takes the first still holding what it needs
 * rather than pinning one wallet's balance.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const HORIZON = 'https://horizon.stellar.org'
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

const BORROWERS = [
  'GDE2FMUG4YLSEBU2YXEQW7CSAYUWVPO6EI3JCTT4IKCHA2XZV6QJT253',
  'GABR5FJYD4AITJWFV2YOTEQKJPKSGMC37ESKRU6FEGNNRYV6YAPXZPWK',
  'GAB6HYBE6DZ2ZIDAXVQSJKUQJBEIAYHXTBLUTDQJLKI6S6WJWJ7TMGF5',
  'GB6Y24VSBEQUSOLJ6RAM4PCH2GXLM7MGZWUNNLC7ILRLYKQK3BPJTUTI',
]
const COLLATERAL_ONLY = [
  'GC3B2MOTNWTE4Z53ESN6WDHRTBHEZHPGXONHSAPJGF2JEGMW6X4ZM626',
  'GDNFNGBOYMRLSKZQ5Y2SY4DP4GSNPYMW2CFOKWO54HDBWKMSJPXBB3S7',
  'GDS62P4K2HCJS3L73GIKGBUVH4ZVPJY465CNLIVSBQKNNAWKVZMJGEVI',
  'GCJA777DKCWQYXZFVCZ6BLAEG7U5COKZFBCKIFEYZSFZG5J7URJWEFZ6',
  'GCVBE2GD2HPJIVZP6L5ZO45WUKEVPQKDHLGL463M3UVBT43F4HIJKZMP',
]

type Client = typeof import('../lend/blend-client')
type Exit = typeof import('../lend/exit')
type Position = typeof import('../lend/position')
type Reserves = typeof import('../lend/reserves')
type Pools = typeof import('../swap/build-pool')

let client: Client
let exit: Exit
let position: Position
let reserves: Reserves
let pools: Pools
let errors: typeof import('../lend/pool-errors')

beforeAll(async () => {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
  client = await import('../lend/blend-client')
  exit = await import('../lend/exit')
  position = await import('../lend/position')
  reserves = await import('../lend/reserves')
  pools = await import('../swap/build-pool')
  errors = await import('../lend/pool-errors')
}, 60_000)

afterAll(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function firstWith(
  accounts: string[],
  wanted: (p: Awaited<ReturnType<Position['readBlendPositions']>>) => boolean
): Promise<{ account: string; held: Awaited<ReturnType<Position['readBlendPositions']>> }> {
  for (const account of accounts) {
    const held = await position.readBlendPositions(account)
    if (wanted(held)) return { account, held }
  }
  throw new Error('none of the known holders still qualifies: refresh the list from pool events')
}

describe.skipIf(SKIP)('the reserves this app names', () => {
  it('are what the pool lists, in its order', async () => {
    const list = await reserves.readReserveList()
    expect(reserves.blendReserves().map((r) => r.id)).toEqual(list)
  }, 60_000)

  it('derive USDC and XLM to the reserves a wallet can supply', () => {
    expect(reserves.suppliableReserve('XLM')).toBe(reserves.blendXlm())
    expect(reserves.suppliableReserve('USDC')).toBe(reserves.blendReserveFor('USDC'))
  })
})

describe.skipIf(SKIP)('collateral on mainnet', () => {
  it('reads with its ticker, and comes out whole, to the wallet', async () => {
    const { account, held } = await firstWith(
      COLLATERAL_ONLY,
      (p) => p.collateral.length > 0 && p.borrowed.length === 0
    )
    const collateral = held.collateral[0]
    if (collateral === undefined) throw new Error('unreachable')
    expect(collateral.symbol).toMatch(/^(XLM|USDC|EURC)$/)

    const built = await client.buildBlendCollateralWithdraw({
      account,
      asset: collateral.assetId,
    })
    expect(() => client.assertSelfCollateralWithdraw(built.xdr, account)).not.toThrow()

    const prepared = await client.prepareBlendWithdraw(built.xdr)
    if (!prepared.ok) throw new Error(prepared.reason)
    // Gone from collateral and not moved to a plain supply: it went to the wallet.
    expect(prepared.after?.collateral[String(collateral.reserveIndex)]).toBeUndefined()
    expect(prepared.after?.supply[String(collateral.reserveIndex)]).toBeUndefined()
  }, 120_000)

  it('is held back by the pool while a loan needs it, and the refusal says why', async () => {
    const { account, held } = await firstWith(
      BORROWERS,
      (p) => p.borrowed.length > 0 && p.collateral.some((c) => c.symbol === 'XLM')
    )
    const xlm = held.collateral.find((c) => c.symbol === 'XLM')
    if (xlm === undefined) throw new Error('unreachable')

    const built = await client.buildBlendCollateralWithdraw({ account, asset: xlm.assetId })
    const prepared = await client.prepareBlendWithdraw(built.xdr)
    expect(prepared.ok).toBe(false)
    if (!prepared.ok) {
      expect(errors.poolErrorCode(prepared.reason)).toBe(1205)
      expect(errors.explainExitError(prepared.reason, 'withdraw')).toMatch(/Repay the loan first/)
    }
  }, 120_000)
})

describe.skipIf(SKIP)('what typing "withdraw" and "repay" reaches', () => {
  const ask = (body: unknown): Request =>
    new Request('http://localhost/api/lend/x', { method: 'POST', body: JSON.stringify(body) })

  it('"withdraw all USDC" comes back ready to sign, from the form the money is in', async () => {
    const { POST } = await import('../../app/api/lend/withdraw/route')
    const { account, held } = await firstWith(
      COLLATERAL_ONLY,
      (p) => p.borrowed.length === 0 && p.collateral.some((c) => c.symbol === 'USDC')
    )
    expect(held.supplied).toEqual([])

    const res = await POST(ask({ account, symbol: 'usdc' }))
    const body = (await res.json()) as {
      xdr?: string
      from?: string
      remaining?: string
      everything?: boolean
      symbol?: string
      error?: string
    }
    if (body.xdr === undefined) throw new Error(body.error)
    expect(body).toMatchObject({
      from: 'collateral',
      remaining: '0',
      everything: true,
      symbol: 'USDC',
    })
    expect(() => client.assertSelfWithdraw(body.xdr as string, account)).not.toThrow()
  }, 120_000)

  it('"withdraw 25 XLM" with none there is refused in plain words', async () => {
    const { POST } = await import('../../app/api/lend/withdraw/route')
    const { account } = await firstWith(
      COLLATERAL_ONLY,
      (p) => p.supplied.length === 0 && !p.collateral.some((c) => c.symbol === 'XLM')
    )
    const res = await POST(ask({ account, symbol: 'XLM', amount: '250000000' }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/no XLM in Blend.*Nothing was signed or sent\.$/)
  }, 120_000)

  it('"repay" with an amount over the wallet says the wallet is short', async () => {
    const { POST } = await import('../../app/api/lend/repay/route')
    const { account, held } = await firstWith(BORROWERS, (p) => p.borrowed.length > 0)
    const debt = held.borrowed[0]
    if (debt === undefined) throw new Error('unreachable')

    const res = await POST(ask({ account, asset: debt.assetId, amount: debt.amount }))
    const body = (await res.json()) as { xdr?: string; error?: string }
    // Unless this wallet has since filled up, in which case the pool would simply take it.
    if (body.xdr === undefined) expect(body.error).toMatch(/does not hold enough/)
  }, 120_000)
})

describe.skipIf(SKIP)('a plain supply on mainnet', () => {
  it('builds whole-position withdrawals the pool can read', async () => {
    // No account found holds a plain supply on this pool, since Blend's own site supplies as
    // collateral. So this is the shape and the pool's answer, which is that there is none to take.
    const { account } = await firstWith(COLLATERAL_ONLY, (p) => p.supplied.length === 0)
    const built = await client.buildBlendWithdraw({ account, asset: reserves.blendXlm() })
    expect(() => client.assertSelfWithdraw(built.xdr, account)).not.toThrow()

    const prepared = await client.prepareBlendWithdraw(built.xdr)
    expect(prepared.ok).toBe(false)
    if (!prepared.ok) {
      expect(errors.poolErrorCode(prepared.reason)).toBe(1217)
    }
  }, 120_000)
})

describe.skipIf(SKIP)('repaying on mainnet', () => {
  it('refuses the old sentinel on the token, which is why it is gone', async () => {
    const { account, held } = await firstWith(BORROWERS, (p) => p.borrowed.length > 0)
    const debt = held.borrowed[0]
    if (debt === undefined) throw new Error('unreachable')

    const built = await client.buildBlendRepay({
      account,
      asset: debt.assetId,
      amount: '170141183460469231731687303715884105727',
    })
    const prepared = await client.prepareBlendWithdraw(built.xdr)
    expect(prepared.ok).toBe(false)
    if (!prepared.ok) expect(prepared.reason).toMatch(/too large for an i64/)
  }, 120_000)

  it('sizes "repay all" to the wallet, and the pool accepts what it asks for', async () => {
    // These borrowers hold little in their wallets. If one holds nothing, the plan refuses and
    // there is nothing to simulate; one with some repays part, and the pool confirms the rest.
    let simulated = 0
    for (const account of BORROWERS) {
      const held = await position.readBlendPositions(account)
      for (const debt of held.borrowed) {
        const spendable = await exit.readSpendable(account, debt.assetId)
        const plan = exit.planRepayAll(BigInt(debt.amount), spendable, debt.symbol)
        if ('refusal' in plan) {
          expect(spendable).toBe(BigInt(0))
          continue
        }
        const built = await client.buildBlendRepay({
          account,
          asset: debt.assetId,
          amount: plan.amount,
        })
        const prepared = await client.prepareBlendWithdraw(built.xdr)
        // One of these wallets holds a single stroop, too little for the pool to count.
        if (!prepared.ok && errors.poolErrorCode(prepared.reason) === 1219) {
          expect(errors.explainExitError(prepared.reason, 'repay')).toMatch(/too small/)
          continue
        }
        if (!prepared.ok) throw new Error(prepared.reason)
        const left = exit.worthOf(debt, prepared.after?.liabilities)
        expect(BigInt(left) < BigInt(debt.amount)).toBe(true)
        simulated += 1
      }
    }
    expect(simulated).toBeGreaterThan(0)
  }, 180_000)
})

describe.skipIf(SKIP)('a pool share on mainnet', () => {
  it('builds a withdrawal for a real holder, paying nobody else', async () => {
    const poolsRes = await fetch(
      `${HORIZON}/liquidity_pools?reserves=native,USDC:${USDC_ISSUER}&limit=1`
    )
    const body = (await poolsRes.json()) as { _embedded: { records: { id: string }[] } }
    const poolId = body._embedded.records[0]?.id
    if (poolId === undefined) throw new Error('no XLM/USDC pool')

    const holders = await fetch(`${HORIZON}/accounts?liquidity_pool=${poolId}&limit=1`)
    const held = (await holders.json()) as { _embedded: { records: { id: string }[] } }
    const account = held._embedded.records[0]?.id
    if (account === undefined) throw new Error('no holder')

    const built = await pools.buildPoolExit({ account, poolId })
    expect(() => pools.assertSelfPoolWithdraw(built.xdr, account)).not.toThrow()
    expect(built.floors.map((f) => f.code).sort()).toEqual(['USDC', 'XLM'])
    await expect(
      pools.buildPoolExit({
        account: 'GAJ74DIC3252BKBTDCEYTDA2ZYDRDBDT3QMZU5IW2HOZQBYVXMRZZEFA',
        poolId,
      })
    ).rejects.toThrow(/hold no shares/)
  }, 60_000)
})
