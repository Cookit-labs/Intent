import { Transaction } from '@mysten/sui/transactions'
import { fromBase64 } from '@mysten/sui/utils'
import { getConfig } from '@naviprotocol/lending'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { suiClient } from '../chains/sui/client'
import { suiModule } from '../chains/sui/module'
import { NAVI_PACKAGE, SPRINGSUI_PACKAGE, SSUI_INFO, SSUI_TYPE } from '../chains/sui/policies'
import { prepareChainAction } from '../chains/prepare'
import { ChainActionRefused, type ChainActionRequest } from '../chains/types'

/**
 * Real quotes and real unsigned transactions against mainnet, read-only. Nothing here
 * signs or sends: each transaction is only built and dry-run, for a public address
 * holding USDC and SUI whose key nobody here has. When that address empties these
 * fail on balance, so swap it for another funded one.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const ACCOUNT = '0xc6fa48a7455bff49124318d5297320441cfac33f83ceea890c485372de917df4'
const EMPTY = '0x0000000000000000000000000000000000000000000000000000000000001234'
const ENV = {}

function prepare(request: ChainActionRequest, account = ACCOUNT) {
  return prepareChainAction(suiModule, request, account)
}

async function dryRun(transaction: string): Promise<boolean> {
  const result = await suiClient().core.simulateTransaction({
    transaction: fromBase64(transaction),
    include: { effects: true },
  })
  return result.Transaction?.effects?.status.success === true
}

const requests: string[] = []
const realFetch = globalThis.fetch

beforeAll(() => {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(input instanceof Request ? input.url : String(input))
    return realFetch(input, init)
  })
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe.skipIf(SKIP)('Sui venues against mainnet', () => {
  it.each([
    ['USDC', 'SUI', '1'],
    ['SUI', 'USDC', '1'],
    ['USDC', 'USDsui', '1'],
    ['USDC', 'USDT', '1'],
  ])(
    'Cetus builds %s to %s, passes the safety check, and dry-runs clean',
    async (tokenIn, tokenOut, amount) => {
      const prepared = await prepare({ kind: 'swap', amount, tokenIn, tokenOut })
      expect(prepared.venueId).toBe('cetus')
      expect(prepared.receive?.symbol).toBe(tokenOut)
      expect(Number(prepared.receive?.amount)).toBeGreaterThan(0)
      expect(prepared.signing.family).toBe('sui')
      if (prepared.signing.family !== 'sui') return

      const data = Transaction.from(prepared.signing.transaction).getData()
      expect(data.sender).toBe(ACCOUNT)
      const venue = suiModule.venues.find((v) => v.id === 'cetus')
      expect(() => venue?.assertSafe(prepared.signing, ACCOUNT)).not.toThrow()
      expect(await dryRun(prepared.signing.transaction)).toBe(true)
    },
    60_000
  )

  it('NAVI builds a USDC deposit, shows its rate, and dry-runs clean', async () => {
    const prepared = await prepare({ kind: 'supply', amount: '1', tokenIn: 'USDC' })
    expect(prepared.venueId).toBe('navi')
    expect(prepared.apy?.basePercent).toBeGreaterThan(0)
    expect(prepared.notes.join(' ')).toMatch(/not guaranteed/)
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')

    const data = Transaction.from(prepared.signing.transaction).getData()
    expect(data.sender).toBe(ACCOUNT)
    const venue = suiModule.venues.find((v) => v.id === 'navi')
    expect(() => venue?.assertSafe(prepared.signing, ACCOUNT)).not.toThrow()
    expect(await dryRun(prepared.signing.transaction)).toBe(true)
  }, 60_000)

  it('Cetus discloses a configured overlay fee, passes the safety check, and dry-runs clean', async () => {
    vi.stubEnv('CETUS_OVERLAY_FEE_RECEIVER', EMPTY)
    vi.stubEnv('CETUS_OVERLAY_FEE_BPS', '10')
    try {
      const prepared = await prepare({
        kind: 'swap',
        amount: '1',
        tokenIn: 'USDC',
        tokenOut: 'SUI',
      })
      expect(prepared.notes.join(' ')).toMatch(/0.1% fee/)
      if (prepared.signing.family !== 'sui') throw new Error('wrong family')
      const venue = suiModule.venues.find((v) => v.id === 'cetus')
      expect(() => venue?.assertSafe(prepared.signing, ACCOUNT)).not.toThrow()
      expect(await dryRun(prepared.signing.transaction)).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  }, 60_000)

  it('SpringSui builds a stake, reports the sSUI, and dry-runs clean', async () => {
    const prepared = await prepare({ kind: 'stake', amount: '1', tokenIn: 'SUI' })
    expect(prepared.venueId).toBe('springsui')
    expect(prepared.receive?.symbol).toBe('sSUI')
    expect(Number(prepared.receive?.amount)).toBeGreaterThan(0.5)
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    const venue = suiModule.venues.find((v) => v.id === 'springsui')
    expect(() => venue?.assertSafe(prepared.signing, ACCOUNT)).not.toThrow()
    expect(await dryRun(prepared.signing.transaction)).toBe(true)
  }, 60_000)

  it("still matches SpringSui's on-chain upgrade cap and object, or the ids need a fresh look", async () => {
    const { objects } = await suiClient().core.getObjects({
      objectIds: ['0x4dc657b6c0fe896f4b94fee1ceac96312dde0a36b94e799caaec30deb53dcd67', SSUI_INFO],
      include: { json: true },
    })
    const [cap, info] = objects as unknown as [{ json?: { package?: string } }, { type?: string }]
    expect(cap.json?.package).toBe(SPRINGSUI_PACKAGE)
    expect(info.type).toContain(SSUI_TYPE)
  }, 30_000)

  it("still matches NAVI's published config, or the allowlist needs a fresh look", async () => {
    const config = await getConfig({ env: 'prod' })
    expect(config.package).toBe(NAVI_PACKAGE)
  }, 30_000)

  it('refuses a token outside the list', async () => {
    await expect(
      prepare({ kind: 'swap', amount: '1', tokenIn: 'USDC', tokenOut: 'FDUSD' })
    ).rejects.toThrow(ChainActionRefused)
  }, 30_000)

  it('refuses a venue that cannot do this', async () => {
    await expect(
      prepare({ kind: 'swap', amount: '1', tokenIn: 'USDC', tokenOut: 'SUI', venue: 'navi' })
    ).rejects.toThrow(/can't swap/)
  }, 30_000)

  it('says plainly when a wallet is short of the token', async () => {
    await expect(prepare({ kind: 'supply', amount: '1', tokenIn: 'USDC' }, EMPTY)).rejects.toThrow(
      /enough USDC/
    )
  }, 60_000)

  it('never spoke JSON-RPC to a fullnode', () => {
    const fullnode = requests.filter((url) => url.includes('fullnode.'))
    expect(fullnode.length).toBeGreaterThan(0)
    for (const url of fullnode) expect(url).toMatch(/\/sui\.rpc\./)
  })
})
