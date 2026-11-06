import {
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  pad,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { describe, expect, it } from 'vitest'

import { evmReader } from '../chains/evm/client'
import {
  createMorphoVenue,
  MORPHO_ADAPTER,
  MORPHO_BLUE_MONAD,
  MORPHO_REVIEWED_MARKETS,
  MORPHO_VAULT,
  readMorphoApy,
  readMorphoLiquidity,
  VAULT_V2_FACTORY_MONAD,
} from '../chains/evm/morpho'
import { sameAddress } from '../chains/evm/submit'

/**
 * Whether what's pinned still holds on Monad, read-only. Nothing here signs or sends: a deposit is
 * tried with `eth_call` and overridden balances, and a withdrawal from a real holder's address,
 * whose key nobody here has. If that holder leaves, swap it for another.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const RPC = process.env['MONAD_RPC_URL']?.trim() || 'https://rpc.monad.xyz'
const HOLDER = '0xB936bCd526069e44bB1F3A9dc155d0C86A8e2fD1'
const NOBODY = '0x000000000000000000000000000000000000dEaD'
const SLOW_MS = 60_000
/** Where Circle's USDC keeps balances and allowances, found by probing with an override. */
const USDC_BALANCE_SLOT = BigInt(9)
const USDC_ALLOWANCE_SLOT = BigInt(10)

const ABI = parseAbi([
  'function asset() view returns (address)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function curator() view returns (address)',
  'function isVaultV2(address) view returns (bool)',
  'function adaptersLength() view returns (uint256)',
  'function adapters(uint256) view returns (address)',
  'function receiveAssetsGate() view returns (address)',
  'function sendAssetsGate() view returns (address)',
  'function receiveSharesGate() view returns (address)',
  'function sendSharesGate() view returns (address)',
  'function marketIdsLength() view returns (uint256)',
  'function marketIds(uint256) view returns (bytes32)',
  'function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
  'function deposit(uint256, address) returns (uint256)',
])

const STREAM_TOKENS = ['XUSD', 'DEUSD', 'SDEUSD']

const slotOf = (key: string, slot: bigint): Hex =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key as Address, slot]))
const allowanceSlot = (owner: string, spender: string): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes32' }],
      [spender as Address, slotOf(owner, USDC_ALLOWANCE_SLOT)]
    )
  )

describe.skipIf(SKIP)('Morpho on Monad, live', () => {
  const reader = evmReader('monad', http(RPC, { timeout: 30_000, retryCount: 2 }))
  const vault = MORPHO_VAULT.address as Address
  const read = (address: string, functionName: string, args: unknown[] = []) =>
    reader.readContract({
      address: address as Address,
      abi: ABI,
      functionName,
      args,
    } as never) as Promise<unknown>

  it('finds code at every pinned address', { timeout: SLOW_MS }, async () => {
    for (const address of [MORPHO_BLUE_MONAD, VAULT_V2_FACTORY_MONAD, vault, MORPHO_ADAPTER]) {
      const code = await reader.getCode({ address: address as Address })
      expect(code?.length ?? 0).toBeGreaterThan(2)
    }
  })

  it('is still the reviewed vault', { timeout: SLOW_MS }, async () => {
    expect(await read(VAULT_V2_FACTORY_MONAD, 'isVaultV2', [vault])).toBe(true)
    expect(sameAddress((await read(vault, 'asset')) as string, MORPHO_VAULT.asset.id)).toBe(true)
    expect(await read(vault, 'symbol')).toBe(MORPHO_VAULT.shareSymbol)
    expect(await read(vault, 'decimals')).toBe(MORPHO_VAULT.shareDecimals)
    // Named Steakhouse Financial in Morpho's curator registry.
    expect(
      sameAddress(
        (await read(vault, 'curator')) as string,
        '0x827e86072B06674a077f592A531dcE4590aDeCdB'
      )
    ).toBe(true)
    expect(await read(vault, 'adaptersLength')).toBe(BigInt(1))
    expect(
      sameAddress((await read(vault, 'adapters', [BigInt(0)])) as string, MORPHO_ADAPTER)
    ).toBe(true)
  })

  it('has no gate that could block a deposit or a withdrawal', { timeout: SLOW_MS }, async () => {
    for (const gate of [
      'receiveAssetsGate',
      'sendAssetsGate',
      'receiveSharesGate',
      'sendSharesGate',
    ]) {
      expect(sameAddress((await read(vault, gate)) as string, `0x${'0'.repeat(40)}`)).toBe(true)
    }
  })

  it(
    'lends only USDC against reviewed collateral, with no Stream token',
    { timeout: SLOW_MS },
    async () => {
      const count = (await read(MORPHO_ADAPTER, 'marketIdsLength')) as bigint
      const collateral: string[] = []
      for (let index = BigInt(0); index < count; index += BigInt(1)) {
        const id = (await read(MORPHO_ADAPTER, 'marketIds', [index])) as string
        expect(MORPHO_REVIEWED_MARKETS).toContain(id)
        const params = (await read(MORPHO_BLUE_MONAD, 'idToMarketParams', [id])) as readonly [
          string,
          string,
        ]
        expect(sameAddress(params[0], MORPHO_VAULT.asset.id)).toBe(true)
        collateral.push(((await read(params[1], 'symbol')) as string).toUpperCase())
      }
      expect(collateral.filter((symbol) => STREAM_TOKENS.includes(symbol))).toEqual([])
    }
  )

  it('reads a free amount and a believable rate', { timeout: SLOW_MS }, async () => {
    expect(await readMorphoLiquidity(reader)).toBeGreaterThan(BigInt(0))
    const apy = await readMorphoApy(reader)
    if (apy !== undefined) {
      expect(apy.basePercent).toBeGreaterThan(0)
      expect(apy.basePercent).toBeLessThan(50)
    }
  })

  it('prepares a deposit for an address that holds USDC', { timeout: SLOW_MS }, async () => {
    const venue = createMorphoVenue({ reader })
    // The vault's own cash stands in for a person with USDC. Nothing is signed.
    const prepared = await venue.prepare({ kind: 'supply', amount: '5', tokenIn: 'USDC' }, vault)
    expect(() => venue.assertSafe(prepared.signing, vault)).not.toThrow()
  })

  it(
    'accepts the deposit this code builds, with funds overridden',
    { timeout: SLOW_MS },
    async () => {
      const units = BigInt(5_000_000)
      await expect(
        reader.call({
          account: NOBODY,
          to: vault,
          data: encodeFunctionData({ abi: ABI, functionName: 'deposit', args: [units, NOBODY] }),
          stateOverride: [
            {
              address: MORPHO_VAULT.asset.id as Address,
              stateDiff: [
                { slot: slotOf(NOBODY, USDC_BALANCE_SLOT), value: pad(toHex(units)) },
                { slot: allowanceSlot(NOBODY, vault), value: pad(toHex(units)) },
              ],
            },
          ],
        })
      ).resolves.toBeDefined()
    }
  )

  it('prepares and tries a withdrawal for a real holder', { timeout: SLOW_MS }, async () => {
    const venue = createMorphoVenue({ reader })
    const prepared = await venue.prepare({ kind: 'withdraw', amount: '5', tokenIn: 'USDC' }, HOLDER)
    expect(() => venue.assertSafe(prepared.signing, HOLDER)).not.toThrow()
  })
})
