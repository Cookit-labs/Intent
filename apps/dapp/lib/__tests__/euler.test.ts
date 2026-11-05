import { describe, expect, it } from 'vitest'

import type { EvmReaderClient } from '../chains/evm/call'
import {
  createEulerAvalancheVenue,
  createEulerMonadVenue,
  EULER_AVALANCHE_COLLATERAL,
  EULER_AVALANCHE_VAULT,
  EULER_MONAD_COLLATERAL,
  EULER_MONAD_VAULT,
} from '../chains/evm/euler'
import { eulerAvalancheListing, eulerMonadListing } from '../chains/evm/euler-listing'
import { AVALANCHE_TOKENS, MONAD_TOKENS } from '../chains/evm/tokens'
import type { ChainActionRequest } from '../chains/types'
import { ACCOUNT, describeVaultRefusals } from './erc4626-refusals'

const SUPPLY: ChainActionRequest = { kind: 'supply', amount: '100', tokenIn: 'USDC' }
const WITHDRAW: ChainActionRequest = { kind: 'withdraw', amount: '100', tokenIn: 'USDC' }

const units = (usdc: number) => BigInt(usdc) * BigInt(1_000_000)
const RATE = BigInt('2500000000000000000')

interface Scene {
  cash?: bigint
  total?: bigint
  borrows?: bigint
  held?: bigint
  shares?: bigint
  room?: bigint
  collateral?: readonly string[]
  rateFails?: boolean
  cashFails?: boolean
}

function fakeReader(scene: Scene, collateral: readonly string[]) {
  const reader = {
    call: async () => ({}),
    readContract: async ({
      address,
      functionName,
      args,
    }: {
      address: string
      functionName: string
      args?: readonly unknown[]
    }) => {
      switch (functionName) {
        case 'balanceOf':
          return address === EULER_MONAD_VAULT.address || address === EULER_AVALANCHE_VAULT.address
            ? (scene.shares ?? BigInt(0))
            : (scene.held ?? units(1_000))
        case 'allowance':
          return BigInt(0)
        case 'totalAssets':
          return scene.total ?? units(1_000_000)
        case 'totalBorrows':
          return scene.borrows ?? units(900_000)
        case 'cash':
          if (scene.cashFails) throw new Error('no reading')
          return scene.cash ?? units(100_000)
        case 'interestRate':
          if (scene.rateFails) throw new Error('no reading')
          return RATE
        case 'interestFee':
          return 1000
        case 'LTVList':
          return scene.collateral ?? collateral
        case 'maxDeposit':
          return scene.room ?? units(10_000_000)
        case 'previewDeposit':
          return (args?.[0] as bigint) - BigInt(1)
        case 'convertToAssets':
          return args?.[0] as bigint
        default:
          throw new Error(`Unexpected read: ${functionName}`)
      }
    },
  }
  return reader as unknown as EvmReaderClient
}

const monadWith = (scene: Scene = {}) =>
  createEulerMonadVenue({ reader: fakeReader(scene, EULER_MONAD_COLLATERAL) })
const avalancheWith = (scene: Scene = {}) =>
  createEulerAvalancheVenue({ reader: fakeReader(scene, EULER_AVALANCHE_COLLATERAL) })

describeVaultRefusals(monadWith(), EULER_MONAD_VAULT, 143, [
  // K3's yzPrime and PT vaults: structured collateral, reviewed and left out.
  '0xa3B64e2674463c98CbD21807055D8C1E008b6e79',
  '0x06047833d9aAC144f7F4e9B8234D2c7DDA1a8BAf',
  // The vault for Avalanche, which isn't one on this chain.
  EULER_AVALANCHE_VAULT.address,
])

describeVaultRefusals(avalancheWith(), EULER_AVALANCHE_VAULT, 43114, [
  // Re7 USDC and K3 USDT Earn: deprecated for exposure to Stream in euler-labels.
  '0xEAF77Df5D03306bCA4EE8b58B6821E6acA76309d',
  '0xE1A62FDcC6666847d5EA752634E45e134B2F824B',
  // Re7's eUSDC-2, which lends against deUSD and sdeUSD.
  '0x39dE0f00189306062D79eDEC6DcA5bb6bFd108f9',
  // 9Summits' own Earn vault, whose queue includes that one.
  '0x4aF3aBE954259fb70b97C57EBD7Ac1eb822028Ef',
])

describe('Euler vaults', () => {
  it('pins the USDC in each chain table', () => {
    expect(MONAD_TOKENS.find((t) => t.symbol === 'USDC')).toEqual(EULER_MONAD_VAULT.asset)
    expect(AVALANCHE_TOKENS.find((t) => t.symbol === 'USDC')).toEqual(EULER_AVALANCHE_VAULT.asset)
  })

  it('lists one venue per chain', () => {
    expect(eulerMonadListing).toMatchObject({
      id: 'euler-monad',
      chains: ['Monad'],
      integration: 'executes',
    })
    expect(eulerAvalancheListing).toMatchObject({
      id: 'euler-avalanche',
      chains: ['Avalanche'],
      integration: 'executes',
    })
  })

  it('names the curator and the collateral on each card', async () => {
    const monad = await monadWith().prepare(SUPPLY, ACCOUNT)
    expect(monad.summary).toContain('Clearstar')
    expect(monad.notes.join(' ')).toMatch(/only to borrowers holding FXRP/)
    const avalanche = await avalancheWith().prepare(SUPPLY, ACCOUNT)
    expect(avalanche.summary).toContain('9 Summits')
    expect(avalanche.notes.join(' ')).toMatch(/savUSD/)
    expect(avalanche.notes.join(' ')).toMatch(/\$93 million/)
  })

  it('works the supply rate out from the borrow rate, what is lent and the fee', async () => {
    const venue = monadWith()
    const { apy } = await venue.prepare(SUPPLY, ACCOUNT)
    const perSecond = 2.5e-9 * 0.9 * 0.9
    const expected = (Math.pow(1 + perSecond, 365.2425 * 86_400) - 1) * 100
    expect(apy?.basePercent).toBeCloseTo(expected, 6)
    expect(apy?.rewardPercent).toBeUndefined()
    await expect(venue.quote?.(SUPPLY, ACCOUNT)).resolves.toEqual({ apyPercent: apy?.basePercent })
  })

  it('shows no rate when it cannot be read, or nothing is borrowed', async () => {
    expect(await monadWith({ rateFails: true }).prepare(SUPPLY, ACCOUNT)).not.toHaveProperty('apy')
    expect(await monadWith({ borrows: BigInt(0) }).prepare(SUPPLY, ACCOUNT)).not.toHaveProperty(
      'apy'
    )
    await expect(monadWith({ rateFails: true }).quote?.(SUPPLY, ACCOUNT)).resolves.toEqual({})
  })

  it('refuses a vault taking collateral that was not reviewed, as a Stream token would be', async () => {
    const collateral = [...EULER_AVALANCHE_COLLATERAL, '0xFECebF56f150A68dDd197c3a6101da35C46693Ac']
    await expect(avalancheWith({ collateral }).prepare(SUPPLY, ACCOUNT)).rejects.toThrow(
      /new collateral/
    )
    await expect(avalancheWith({ collateral }).quote?.(SUPPLY, ACCOUNT)).rejects.toThrow(
      /new collateral/
    )
  })

  it('refuses a stuck vault, the way Stream left others on Avalanche', async () => {
    const venue = avalancheWith({ cash: units(1_000), total: units(1_000_000) })
    await expect(venue.prepare(SUPPLY, ACCOUNT)).rejects.toThrow(/won't add to it/)
    await expect(venue.quote?.(SUPPLY, ACCOUNT)).rejects.toThrow(/won't add to it/)
  })

  it('refuses more than the vault has room for', async () => {
    await expect(monadWith({ room: units(10) }).prepare(SUPPLY, ACCOUNT)).rejects.toThrow(
      /room for about 10 more USDC/
    )
  })

  it('refuses when the vault cannot be read', async () => {
    await expect(monadWith({ cashFails: true }).prepare(SUPPLY, ACCOUNT)).rejects.toThrow(
      /couldn't read/
    )
  })

  it('builds a withdrawal that stays in the person’s hands', async () => {
    const venue = avalancheWith({ shares: units(500) })
    const prepared = await venue.prepare(WITHDRAW, ACCOUNT)
    expect(prepared.signing).toMatchObject({ family: 'evm', chainId: 43114 })
    expect(() => venue.assertSafe(prepared.signing, ACCOUNT)).not.toThrow()
  })

  it('says plainly when the vault cannot pay out that much now', async () => {
    const venue = avalancheWith({ shares: units(500), cash: units(40) })
    await expect(venue.prepare(WITHDRAW, ACCOUNT)).rejects.toThrow(/can pay out about 40 USDC/)
  })

  it('leaves a way out when the cash cannot be read', async () => {
    const venue = monadWith({ shares: units(500), cashFails: true })
    await expect(venue.prepare(WITHDRAW, ACCOUNT)).resolves.toMatchObject({ kind: 'withdraw' })
  })
})
