import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  maxUint256,
  pad,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { describe, expect, it } from 'vitest'

import {
  AAVE_AVALANCHE_MARKET,
  AAVE_MONAD_MARKET,
  createAaveVenue,
  NEVERLAND_MARKET,
  type AaveMarket,
} from '../chains/evm/aave'
import { createBeefyMonadVenue } from '../chains/evm/beefy'
import type { EvmReaderClient } from '../chains/evm/call'
import { evmReader } from '../chains/evm/client'
import { createCurvanceVenue } from '../chains/evm/curvance'
import { createEulerAvalancheVenue, createEulerMonadVenue } from '../chains/evm/euler'
import { createFastlaneVenue, SHMON } from '../chains/evm/fastlane'
import { createMorphoVenue, MORPHO_VAULT } from '../chains/evm/morpho'
import { createSablierVenue, SABLIER_LOCKUP, SABLIER_LOCKUP_ABI } from '../chains/evm/sablier'
import { EVM_CHAINS, type EvmChain } from '../chains/evm/tokens'
import type { ChainActionRequest, ChainVenue, SigningPayload } from '../chains/types'

/**
 * Every exit, built for real holders and tried with `eth_call` as them. Nothing signs or sends, and
 * nobody here has their keys. Holders move: when one leaves, its case fails on balance, so swap in
 * another from the venue's token transfers.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const SLOW_MS = 180_000

const RPC: Record<EvmChain, string> = {
  avalanche: process.env['AVALANCHE_RPC_URL'] ?? 'https://avalanche-c-chain-rpc.publicnode.com',
  monad: process.env['MONAD_RPC_URL'] ?? 'https://rpc1.monad.xyz',
}

function reader(chain: EvmChain): EvmReaderClient {
  return evmReader(chain, http(RPC[chain], { timeout: 30_000, retryCount: 6, retryDelay: 2_000 }))
}

const avalanche = reader('avalanche')
const monad = reader('monad')
const READERS: Record<EvmChain, EvmReaderClient> = { avalanche, monad }

// Circle's FiatToken keeps balances at slot 9 and allowances at slot 10.
const USDC_BALANCE_SLOT = BigInt(9)
const USDC_ALLOWANCE_SLOT = BigInt(10)
const LOTS = BigInt(10) ** BigInt(15)

function mapSlot(key: Address | Hex, slot: bigint | Hex): Hex {
  const keyType = key.length === 42 ? 'address' : 'bytes32'
  const slotType = typeof slot === 'bigint' ? 'uint256' : 'bytes32'
  return keccak256(
    encodeAbiParameters([{ type: keyType }, { type: slotType }], [key, slot] as never)
  )
}

function revertDataOf(error: unknown): string {
  let current = error as { data?: unknown; cause?: unknown } | undefined
  while (current !== undefined && current !== null) {
    if (typeof current.data === 'string') return current.data
    current = current.cause as typeof current
  }
  return ''
}

function asEvm(signing: SigningPayload) {
  if (signing.family !== 'evm') throw new Error('Expected an EVM payload.')
  return signing
}

const POOL = parseAbi([
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)',
  'function getConfiguration(address asset) view returns (uint256)',
])

const whole = (kind: ChainActionRequest['kind'], tokenIn: string, amount: string) => ({
  kind,
  tokenIn,
  amount,
  wholePosition: true,
})

function positionOf(venue: ChainVenue, account: string, slot: string, symbol: string) {
  return venue.positions?.(account).then((all) => {
    const found = all.find((p) => p.slot === slot && p.symbol === symbol)
    if (found === undefined) throw new Error(`${account} holds no ${symbol} in ${slot}`)
    return found.amount
  })
}

interface AaveCase {
  name: string
  market: AaveMarket
  /** Holds USDC supplied and nothing borrowed. */
  supplier: Address
  /** Owes USDC. */
  borrower: Address
}

const AAVE_CASES: AaveCase[] = [
  {
    name: 'Aave on Avalanche',
    market: AAVE_AVALANCHE_MARKET,
    supplier: '0x0f9274F72a787B612A17FC22dd4e1894F442A6c8',
    borrower: '0xF5415033F7211eA19bA2A448eC04db9C99eAd270',
  },
  {
    name: 'Aave on Monad',
    market: AAVE_MONAD_MARKET,
    // Beefy's strategy, the largest supplier here.
    supplier: '0x6105E2bF96283800781d31C6Ad18c6FBBde688CD',
    borrower: '0xCf0a12CBd8088fc5f84ad431E71787157041cD69',
  },
  {
    name: 'Neverland on Monad',
    market: NEVERLAND_MARKET,
    supplier: '0x8d5c2Df3Eef09088Fcccf3376D8EcD0Dd505f642',
    borrower: '0x1111715A738b867A2B92B2fab52AC96e3D511111',
  },
]

describe.skipIf(SKIP).each(AAVE_CASES)('$name exits, live', ({ market, supplier, borrower }) => {
  const chainReader = READERS[market.chain]
  const venue = createAaveVenue(market, chainReader)
  const usdc = market.tokens.find((t) => t.symbol === 'USDC')?.id as Address
  const pool = market.pool as Address

  it(
    'takes all of a real supply with the Pool’s max, paying the holder at least what was read',
    async () => {
      const amount = (await positionOf(venue, supplier, 'supplied', 'USDC')) as string
      const prepared = await venue.prepare(whole('withdraw', 'USDC', amount), supplier)
      const signing = asEvm(prepared.signing)
      expect(() => venue.assertSafe(signing, supplier)).not.toThrow()
      const { args } = decodeFunctionData({ abi: POOL, data: signing.data as Hex })
      expect(args?.[1]).toBe(maxUint256)
      const result = await chainReader.call({
        account: supplier,
        to: pool,
        data: signing.data as Hex,
      })
      const paid = decodeFunctionResult({
        abi: POOL,
        functionName: 'withdraw',
        data: result.data as Hex,
      })
      expect(paid).toBeGreaterThanOrEqual(BigInt(Math.floor(Number(amount) * 1e6)))
    },
    SLOW_MS
  )

  it(
    'repays all of a real loan, taking only the debt though it names a little more',
    async () => {
      const amount = (await positionOf(venue, borrower, 'borrowed', 'USDC')) as string
      // The wallet may not hold the debt, so it is funded for the build and for this one call below.
      const funded = {
        ...chainReader,
        readContract: (args: { functionName: string }) => {
          if (args.functionName === 'balanceOf') return Promise.resolve(LOTS)
          if (args.functionName === 'allowance') return Promise.resolve(BigInt(0))
          return chainReader.readContract(args as never)
        },
      } as unknown as EvmReaderClient
      const built = createAaveVenue(market, funded)
      const prepared = await built.prepare(whole('repay', 'USDC', amount), borrower)
      const signing = asEvm(prepared.signing)
      expect(signing.approval?.to).toBe(usdc)
      expect(() => venue.assertSafe(signing, borrower)).not.toThrow()

      const { args } = decodeFunctionData({ abi: POOL, data: signing.data as Hex })
      const named = args?.[1] as bigint
      const owed = BigInt(Math.round(Number(amount) * 1e6))
      expect(named).toBeGreaterThan(owed)

      const allowance = mapSlot(pool, mapSlot(borrower, USDC_ALLOWANCE_SLOT))
      const result = await chainReader.call({
        account: borrower,
        to: pool,
        data: signing.data as Hex,
        stateOverride: [
          {
            address: usdc,
            stateDiff: [
              {
                slot: mapSlot(borrower, USDC_BALANCE_SLOT),
                value: pad(toHex(named * BigInt(2))),
              },
              { slot: allowance, value: pad(toHex(named)) },
            ],
          },
        ],
      })
      const took = decodeFunctionResult({
        abi: POOL,
        functionName: 'repay',
        data: result.data as Hex,
      })
      expect(took).toBeLessThan(named)
      expect(took).toBeGreaterThanOrEqual(owed)
    },
    SLOW_MS
  )

  it(
    'lets a withdraw through a frozen reserve and stops at a paused one, on the real code',
    async () => {
      const word = await chainReader.readContract({
        address: pool,
        abi: POOL,
        functionName: 'getConfiguration',
        args: [usdc],
      })
      // `ReserveData.configuration` opens the reserve's struct in `_reserves`, at slot 52.
      const slot = mapSlot(usdc, BigInt(52))
      const stored = await chainReader.getStorageAt({ address: pool, slot })
      expect(BigInt(stored ?? '0x0')).toBe(word)
      const FROZEN_BIT = BigInt(1) << BigInt(57)
      const PAUSED_BIT = BigInt(1) << BigInt(60)
      const tryWith = (bit: bigint) =>
        chainReader.call({
          account: supplier,
          to: pool,
          data: encodeFunctionData({
            abi: POOL,
            functionName: 'withdraw',
            args: [usdc, maxUint256, supplier],
          }),
          stateOverride: [
            {
              address: pool,
              stateDiff: [{ slot, value: pad(toHex(word | bit), { size: 32 }) }],
            },
          ],
        })
      await expect(tryWith(FROZEN_BIT)).resolves.toBeDefined()
      // ReservePaused() on Aave V3, and code 29 on the older code Neverland runs.
      const paused = await tryWith(PAUSED_BIT).then(
        () => 'it went through',
        (error: unknown) => String((error as Error).message) + revertDataOf(error)
      )
      expect(paused).toMatch(/d37f5f1c|reason: 29/)
    },
    SLOW_MS
  )
})

describe.skipIf(SKIP)('Aave collateral that counts for nothing, live', () => {
  it(
    'blocks other collateral on the real Pool, and the venue puts that error into words',
    async () => {
      // Posts USDC, which counts for nothing toward a loan on this market, with WETH.e and a loan.
      const borrower = '0x04249935b89230B1aA1554C144a288b931E83BaA'
      // This loan is under the app's own floor, which would refuse first, so that check reads no
      // debt here. The Pool still sees the real account, and its real error comes back.
      const pastTheFloor = {
        ...avalanche,
        readContract: async (args: { functionName: string }) => {
          const read = await avalanche.readContract(args as never)
          if (args.functionName !== 'getUserAccountData') return read
          const [collateral, , ...rest] = read as readonly bigint[]
          return [collateral, BigInt(0), ...rest]
        },
      } as unknown as EvmReaderClient
      const venue = createAaveVenue(AAVE_AVALANCHE_MARKET, pastTheFloor)
      await expect(
        venue.prepare({ kind: 'withdraw', amount: '0.000000000001', tokenIn: 'WETH.e' }, borrower)
      ).rejects.toThrow(/withdraw that token first.*Nothing was signed or sent\.$/)
    },
    SLOW_MS
  )
})

describe.skipIf(SKIP)('Aave collateral that backs a loan, live', () => {
  it(
    'refuses all of it in plain words for a real borrower',
    async () => {
      const borrower = '0x58EA58212b66A33f566F2333bc5D398FA6F825d9'
      const venue = createAaveVenue(AAVE_AVALANCHE_MARKET, avalanche)
      const amount = (await positionOf(venue, borrower, 'supplied', 'WAVAX')) as string
      await expect(venue.prepare(whole('withdraw', 'WAVAX', amount), borrower)).rejects.toThrow(
        /backs your loan.*Nothing was signed or sent\.$/
      )
    },
    SLOW_MS
  )
})

const REDEEM = parseAbi([
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
])

async function expectRedeemsAll(
  venue: ChainVenue,
  holder: Address,
  vault: Address,
  client: EvmReaderClient
) {
  const amount = (await positionOf(venue, holder, 'supplied', 'USDC')) as string
  const prepared = await venue.prepare(whole('withdraw', 'USDC', amount), holder)
  const signing = asEvm(prepared.signing)
  expect(() => venue.assertSafe(signing, holder)).not.toThrow()
  const shares = await client.readContract({
    address: vault,
    abi: REDEEM,
    functionName: 'balanceOf',
    args: [holder],
  })
  const { functionName, args } = decodeFunctionData({ abi: REDEEM, data: signing.data as Hex })
  expect(functionName).toBe('redeem')
  expect(args).toEqual([shares, getAddress(holder), getAddress(holder)])
  const result = await client.call({ account: holder, to: vault, data: signing.data as Hex })
  const paid = decodeFunctionResult({
    abi: REDEEM,
    functionName: 'redeem',
    data: result.data as Hex,
  })
  // The read figure is the live one, so what comes out sits on it, within a hair of interest.
  const read = Number(amount)
  expect(Number(paid) / 1e6).toBeGreaterThanOrEqual(read * 0.9999)
  expect(Number(paid) / 1e6).toBeLessThanOrEqual(read * 1.0001)
}

describe.skipIf(SKIP)('ERC-4626 exits, live', () => {
  it(
    'Morpho redeems every share of a real holder',
    () =>
      expectRedeemsAll(
        createMorphoVenue({ reader: monad }),
        '0x255c7705e8BB334DfCae438197f7C4297988085a',
        MORPHO_VAULT.address as Address,
        monad
      ),
    SLOW_MS
  )

  it(
    'Euler redeems every share of a real holder',
    () =>
      expectRedeemsAll(
        createEulerAvalancheVenue({ reader: avalanche }),
        '0xf3a05b89b8f857A5aD6532C8e7c4584b0d80DDF2',
        '0x37ca03aD51B8ff79aAD35FadaCBA4CEDF0C3e74e',
        avalanche
      ),
    SLOW_MS
  )

  it(
    'Curvance redeems every share of a real holder, at the rate it read',
    () =>
      expectRedeemsAll(
        createCurvanceVenue(() => monad),
        '0x17406facecB4f0c4389634B79ed2529D2c967981',
        '0x8EE9FC28B8Da872c38A496e9dDB9700bb7261774',
        monad
      ),
    SLOW_MS
  )

  it(
    'Curvance shows posted collateral, and refuses all of it until it comes off',
    async () => {
      const holder = '0xf2aCD72302977fB4bCfC9B90389a040239e2aE7e'
      const venue = createCurvanceVenue(() => monad)
      const amount = (await positionOf(venue, holder, 'supplied', 'USDC')) as string
      await expect(venue.prepare(whole('withdraw', 'USDC', amount), holder)).rejects.toThrow(
        /remove the collateral/
      )
    },
    SLOW_MS
  )

  it.each<[string, ChainVenue, Address]>([
    [
      'Euler on Monad, whose largest holder holds more than it has free',
      createEulerMonadVenue({ reader: monad }),
      '0xE1BcA19baA63894D374578320551633320436523',
    ],
    [
      'Euler on Avalanche, likewise',
      createEulerAvalancheVenue({ reader: avalanche }),
      '0x4aF3aBE954259fb70b97C57EBD7Ac1eb822028Ef',
    ],
  ])(
    '%s, says what it can pay',
    async (_name, venue, holder) => {
      const amount = (await positionOf(venue, holder, 'supplied', 'USDC')) as string
      await expect(venue.prepare(whole('withdraw', 'USDC', amount), holder)).rejects.toThrow(
        /can pay out about/
      )
    },
    SLOW_MS
  )
})

describe.skipIf(SKIP)('Beefy exit, live', () => {
  it(
    'builds withdrawAll for a real holder, and it runs',
    async () => {
      const holder = '0x9b93760f95ABc7ee4913b4Fb6e169719D62c50AF'
      const venue = createBeefyMonadVenue(() => monad)
      const amount = (await positionOf(venue, holder, 'supplied', 'USDC')) as string
      const prepared = await venue.prepare(whole('withdraw', 'USDC', amount), holder)
      const signing = asEvm(prepared.signing)
      expect(signing.data).toBe('0x853828b6')
      expect(() => venue.assertSafe(signing, holder)).not.toThrow()
      await monad.call({ account: holder, to: signing.to as Address, data: signing.data as Hex })
    },
    SLOW_MS
  )
})

describe.skipIf(SKIP)('FastLane exit, live', () => {
  it(
    'exits every shMON of a real holder, paying at least the minimum',
    async () => {
      const holder = '0x50649A1ea82f3bD8659b5D8f5A17DdC0b0Ee7ccf'
      const venue = createFastlaneVenue(monad)
      const amount = (await positionOf(venue, holder, 'staked', 'shMON')) as string
      const prepared = await venue.prepare(whole('unstake', 'shMON', amount), holder)
      const signing = asEvm(prepared.signing)
      expect(signing.to).toBe(SHMON)
      expect(() => venue.assertSafe(signing, holder)).not.toThrow()
      await monad.call({ account: holder, to: SHMON as Address, data: signing.data as Hex })
    },
    SLOW_MS
  )
})

const STREAM_VIEWS = parseAbi([
  'function refundableAmountOf(uint256 streamId) view returns (uint128)',
])

const SENDER_OF_STREAM_7 = '0xf26994E6Af0b95cCa8DFA22A0BC25E1f38a54C42'
// Streams that have run out, in tokens this app lists, on each chain.
const SPENT: Record<EvmChain, { id: string; sender: Address }> = {
  avalanche: { id: '10', sender: '0xe135D9F010f5D0ED203E3f3fC47F66e2ECEd721d' },
  monad: { id: '15', sender: '0xE46DD62eCB9B9BD5FfC545E8826Fc5fF18Eab8f2' },
}

describe.skipIf(SKIP).each<EvmChain>(['avalanche', 'monad'])(
  'Sablier cancel on %s, live',
  (chain) => {
    const client = READERS[chain]
    const venue = createSablierVenue(chain, client)
    const lockup = SABLIER_LOCKUP[chain] as Address
    const data = encodeFunctionData({
      abi: SABLIER_LOCKUP_ABI,
      functionName: 'cancel',
      args: [BigInt(7)],
    })
    const cancel = (streamId: string): ChainActionRequest => ({
      kind: 'cancel',
      amount: 'all',
      tokenIn: 'STREAM',
      streamId,
    })

    it(
      'runs for the real sender with no value, refunding what the contract says is refundable',
      async () => {
        const refundable = await client.readContract({
          address: lockup,
          abi: STREAM_VIEWS,
          functionName: 'refundableAmountOf',
          args: [BigInt(7)],
        })
        const result = await client.call({ account: SENDER_OF_STREAM_7, to: lockup, data })
        const refund = decodeFunctionResult({
          abi: SABLIER_LOCKUP_ABI,
          functionName: 'cancel',
          data: result.data as Hex,
        })
        expect(refund).toBeGreaterThan(BigInt(0))
        expect(Number(refund)).toBeCloseTo(Number(refundable), -13)
        expect(() =>
          venue.assertSafe(
            { family: 'evm', chainId: EVM_CHAINS[chain].chain.id, to: lockup, data, value: '0' },
            SENDER_OF_STREAM_7
          )
        ).not.toThrow()
      },
      SLOW_MS
    )

    it(
      'is refused by the contract for anyone else',
      async () => {
        await expect(
          client.call({ account: '0x000000000000000000000000000000000000bEEF', to: lockup, data })
        ).rejects.toThrow()
      },
      SLOW_MS
    )

    it(
      'refuses in plain words a stream that isn’t yours, is spent, or is in an unlisted token',
      async () => {
        await expect(
          venue.prepare(cancel('7'), '0x000000000000000000000000000000000000bEEF')
        ).rejects.toThrow(/wasn't started by this wallet/)
        await expect(venue.prepare(cancel('7'), SENDER_OF_STREAM_7)).rejects.toThrow(
          /a token I haven't confirmed/
        )
        await expect(venue.prepare(cancel(SPENT[chain].id), SPENT[chain].sender)).rejects.toThrow(
          /finished streaming/
        )
        await expect(venue.prepare(cancel('999999'), SENDER_OF_STREAM_7)).rejects.toThrow(
          /There is no stream/
        )
      },
      SLOW_MS
    )

    it(
      'reads every stream to list a sender’s, and lists no token it can’t confirm',
      async () => {
        await expect(venue.positions?.(SENDER_OF_STREAM_7)).resolves.toEqual([])
        await expect(
          venue.positions?.('0x000000000000000000000000000000000000bEEF')
        ).resolves.toEqual([])
      },
      SLOW_MS
    )
  }
)
