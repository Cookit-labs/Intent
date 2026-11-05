import { parseAbi, zeroAddress, type Address } from 'viem'

import { ChainActionRefused, type ChainToken, type PreparedAction } from '../types'
import type { EvmReaderClient } from './call'
import {
  createVaultVenue,
  type ReviewedVault,
  type VaultVenueConfig,
  type VaultVenueDeps,
} from './erc4626'
import { sameAddress } from './submit'

/**
 * Euler's lending vaults. Every address below comes from Euler's own repos: euler-xyz/euler-labels
 * <chainId>/products.json names a vault and its curator, and euler-xyz/euler-interfaces
 * addresses/<chainId>/CoreAddresses.json names the factory, whose `isProxy` confirms the vault.
 *
 * Refused by leaving them out on Avalanche: the Re7 and K3 Earn vaults, which euler-labels marks
 * as deprecated for exposure to Stream's insolvent positions, and 9Summits' own Earn vault, whose
 * queue still includes Re7's eUSDC-2 (0x39dE0f...08f9), which lends against deUSD and sdeUSD and
 * holds almost no cash. On Monad: K3's PT and yzPrime vaults, whose collateral is structured
 * credit, and K3's smaller vaults, which lend at 79 to 85% where Clearstar's lends at 58%.
 */

// Monad's factory, from euler-interfaces addresses/143/CoreAddresses.json. Code confirmed by RPC.
export const EULER_FACTORY_MONAD = '0xba4Dd672062dE8FeeDb665DD4410658864483f1E'
// Avalanche's factory, from euler-interfaces addresses/43114/CoreAddresses.json. Confirmed by RPC.
export const EULER_FACTORY_AVALANCHE = '0xaf4B4c18B17F6a2B32F6c398a3910bdCD7f26181'

const MONAD_USDC: ChainToken = {
  symbol: 'USDC',
  id: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  decimals: 6,
  name: 'USD Coin',
}

const AVALANCHE_USDC: ChainToken = {
  symbol: 'USDC',
  id: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  decimals: 6,
  name: 'USD Coin',
}

// euler-labels 143/products.json "clearstar-reactor". Governor 0xb3CF59...2B44 is Clearstar's
// multisig in euler-labels entities.json and in Morpho's curator registry.
export const EULER_MONAD_VAULT: ReviewedVault = {
  address: '0x1905EDDF5943ef6C92Ccf1469bd40fC2cB4A77b0',
  name: 'Clearstar Reactor USDC',
  shareSymbol: 'eUSDC-12',
  shareDecimals: 6,
  asset: MONAD_USDC,
  curator: 'Clearstar',
}

// euler-labels 43114/products.json "9summits-avalanche". Governor 0x23E6ae...AEF is 9 Summits'
// multisig in euler-labels entities.json.
export const EULER_AVALANCHE_VAULT: ReviewedVault = {
  address: '0x37ca03aD51B8ff79aAD35FadaCBA4CEDF0C3e74e',
  name: '9 Summits USDC',
  shareSymbol: 'eUSDC-19',
  shareDecimals: 6,
  asset: AVALANCHE_USDC,
  curator: '9 Summits',
}

/** The vault's `LTVList`, FXRP only. Euler only ever appends to this list. */
export const EULER_MONAD_COLLATERAL: readonly string[] = [
  '0x144290085Da25E3078425C6F4A477fD8caB0c43e',
]

/** The vault's `LTVList`: sUSDe, BTC.b, savUSD, sAVAX and WETH.e, some in more than one vault. */
export const EULER_AVALANCHE_COLLATERAL: readonly string[] = [
  '0x3F96e387eC6462DFBe9F05838943D19307dD2752',
  '0xF983f92bd962A94EAc85a8c58237C1CC1cDfBBBa',
  '0xbaC3983342b805E66F8756E265b3B0DdF4B685Fc',
  '0x5497210b19f91bE6446092C38D4cB6116D52578e',
  '0x6b640afFdE7cFa8322cA5c7F8bB7d276de3d30A3',
  '0x9B1DC432150cEF8f129A9eEa3CA8364d0b06904f',
  '0x4eC5B9a4d4FD9E35d4f881D35AAB9877bfdA5803',
  '0x38a559c2b6eF3fF7Cdc40a800D6351a2B70b2243',
  '0x7485484Dab196C615AE21453C3ABd732977562f2',
  '0xf3aCc3Fc22E376fa3dD21CF883B60DDE9cf4E34f',
]

const EVK_ABI = parseAbi([
  'function cash() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function totalBorrows() view returns (uint256)',
  'function interestRate() view returns (uint256)',
  'function interestFee() view returns (uint16)',
  'function maxDeposit(address account) view returns (uint256)',
  'function LTVList() view returns (address[])',
  'function hookConfig() view returns (address hookTarget, uint32 hookedOps)',
])

/** OP_WITHDRAW and OP_REDEEM, in euler-vault-kit src/EVault/shared/Constants.sol. */
const EXIT_OPS = (1 << 2) | (1 << 3)

/** `interestRate` is a per-second rate scaled by 1e27, and `interestFee` is in hundredths of a percent. */
const RATE_SCALE = 1e27
const FEE_SCALE = 1e4
const YEAR_SECONDS = 365.2425 * 86_400

/**
 * What lenders earn right now, worked out as Euler's own lens does: the borrow rate, on the share
 * of the vault that is lent, after the fee. Over a year, as if nothing moved.
 */
function readSupplyApy(vault: ReviewedVault) {
  const address = vault.address as Address
  return async (reader: EvmReaderClient): Promise<PreparedAction['apy']> => {
    const [rate, fee, borrows, total] = await Promise.all([
      reader.readContract({ address, abi: EVK_ABI, functionName: 'interestRate' }),
      reader.readContract({ address, abi: EVK_ABI, functionName: 'interestFee' }),
      reader.readContract({ address, abi: EVK_ABI, functionName: 'totalBorrows' }),
      reader.readContract({ address, abi: EVK_ABI, functionName: 'totalAssets' }),
    ])
    if (total === BigInt(0) || rate === BigInt(0) || borrows === BigInt(0)) return undefined
    const perSecond =
      (Number(rate) / RATE_SCALE) * (Number(borrows) / Number(total)) * (1 - fee / FEE_SCALE)
    return { basePercent: Math.expm1(YEAR_SECONDS * Math.log1p(perSecond)) * 100 }
  }
}

/** The card names the collateral, so a vault taking anything else refuses until it is reviewed. */
function assertCollateral(vault: ReviewedVault, reviewed: readonly string[]) {
  return async (reader: EvmReaderClient): Promise<void> => {
    const listed = await reader.readContract({
      address: vault.address as Address,
      abi: EVK_ABI,
      functionName: 'LTVList',
    })
    if (!listed.every((entry) => reviewed.some((known) => sameAddress(known, entry)))) {
      throw new ChainActionRefused(
        `${vault.name} takes new collateral since I reviewed it, so this stays blocked until it is checked again. Nothing was signed or sent.`
      )
    }
  }
}

function eulerConfig(
  id: string,
  chain: VaultVenueConfig['chain'],
  vault: ReviewedVault,
  collateral: readonly string[],
  notes: readonly string[]
): VaultVenueConfig {
  const address = vault.address as Address
  return {
    id,
    name: 'Euler',
    chain,
    vault,
    notes,
    readLiquidity: (reader) => reader.readContract({ address, abi: EVK_ABI, functionName: 'cash' }),
    readApy: readSupplyApy(vault),
    assertAsReviewed: assertCollateral(vault, collateral),
    readRoom: (reader, account) =>
      reader.readContract({
        address,
        abi: EVK_ABI,
        functionName: 'maxDeposit',
        args: [account],
      }),
    // A hooked operation with no hook contract is switched off. One with a hook is that hook's to
    // decide, which only trying the call can show.
    readExitBlock: async (reader) => {
      const [target, ops] = await reader.readContract({
        address,
        abi: EVK_ABI,
        functionName: 'hookConfig',
      })
      return target === zeroAddress && (ops & EXIT_OPS) !== 0
        ? `${vault.curator} has switched off withdrawals from ${vault.name}.`
        : undefined
    },
  }
}

const sharedNotes = (curator: string): readonly string[] => [
  `${curator} can change this vault's collateral, limits and rates with no delay the vault enforces, and the admin of Euler's vault factory can upgrade its code.`,
  'Any rate shown is worked out from the vault’s current borrow rate, how much is lent out and its fee. It moves as people borrow and repay, and it is not promised.',
  'Euler’s older V1 lost $197 million to an exploit in March 2023. This vault runs on V2, a separate codebase.',
]

export const EULER_MONAD_CONFIG = eulerConfig(
  'euler-monad',
  'monad',
  EULER_MONAD_VAULT,
  EULER_MONAD_COLLATERAL,
  [
    'Curated by Clearstar. This vault lends your USDC only to borrowers holding FXRP, a wrapped form of XRP. If FXRP or its price feed fails, the USDC lent against it may not come back, and that loss falls on everyone in the vault.',
    'Almost all the money in this vault comes from Clearstar’s own Earn vault. If that moves out, little may be free to withdraw until borrowers repay.',
    ...sharedNotes('Clearstar'),
  ]
)

export const EULER_AVALANCHE_CONFIG = eulerConfig(
  'euler-avalanche',
  'avalanche',
  EULER_AVALANCHE_VAULT,
  EULER_AVALANCHE_COLLATERAL,
  [
    'Curated by 9 Summits. This small vault lends your USDC to borrowers holding mostly savUSD, plus sUSDe, BTC.b, sAVAX and WETH.e. savUSD and sUSDe are synthetic dollars whose backing depends on the companies behind them. If one fails, that loss falls on everyone in the vault.',
    'Stream Finance reported losing about $93 million in November 2025, and Euler has since deprecated other vaults on Avalanche for exposure to it, with depositors offered about 80% back for a limited time. This vault lists none of Stream’s or Elixir’s tokens as collateral.',
    ...sharedNotes('9 Summits'),
  ]
)

export function createEulerMonadVenue(deps: VaultVenueDeps = {}) {
  return createVaultVenue(EULER_MONAD_CONFIG, deps)
}

export function createEulerAvalancheVenue(deps: VaultVenueDeps = {}) {
  return createVaultVenue(EULER_AVALANCHE_CONFIG, deps)
}
