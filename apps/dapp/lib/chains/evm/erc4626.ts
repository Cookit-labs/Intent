import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  isAddress,
  maxUint256,
  parseAbi,
  type Address,
} from 'viem'

import {
  ChainActionRefused,
  quotedApy,
  takesOnly,
  tokenBySymbol,
  toBaseUnits,
  withArticle,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
  type VenuePosition,
  type VenueQuote,
} from '../types'
import {
  approvalNote,
  buildEvmCall,
  evmCallVenueParts,
  type CheckContext,
  type DecodedCall,
  type EvmCallPolicy,
  type EvmReaderClient,
} from './call'
import { evmReader, type EvmClient } from './client'
import { sameAddress } from './submit'
import { EVM_CHAINS, type EvmChain } from './tokens'

/**
 * Earning in one reviewed ERC-4626 vault. A request can't name a vault, so each venue pins the one
 * it was reviewed for, and every other vault is an unknown contract.
 */

export interface ReviewedVault {
  address: string
  name: string
  shareSymbol: string
  shareDecimals: number
  asset: ChainToken
  curator: string
}

export interface VaultVenueConfig {
  id: string
  name: string
  chain: EvmChain
  vault: ReviewedVault
  /** The curator, what is lent against, who can change what, and past incidents. */
  notes: readonly string[]
  /** What can be taken out right now, in the asset's base units. */
  readLiquidity: (reader: EvmReaderClient) => Promise<bigint>
  /** No rate read means no rate. Throws a refusal only for a reading that should stop a deposit. */
  readApy: (reader: EvmReaderClient) => Promise<PreparedAction['apy']>
  /** Refuses a vault that has drifted from what was reviewed, such as new collateral. */
  assertAsReviewed: (reader: EvmReaderClient) => Promise<void>
  /** How much more it will take, where it can say. Morpho's `maxDeposit` always answers zero. */
  readRoom?: ((reader: EvmReaderClient, account: Address) => Promise<bigint>) | undefined
  /** Why this account can't leave right now, in plain words, where the vault can bar an exit. */
  readExitBlock?:
    | ((reader: EvmReaderClient, account: Address) => Promise<string | undefined>)
    | undefined
}

export interface VaultVenueDeps {
  reader?: EvmReaderClient | undefined
  client?: EvmClient | undefined
}

const VAULT_CALLS = parseAbi([
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)',
])

const VAULT_READS = parseAbi([
  'function totalAssets() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function previewDeposit(uint256 assets) view returns (uint256)',
])

/** Under this much free, a vault is the kind Stream left stuck on Avalanche, so it takes no more. */
const MIN_FREE_PERCENT = BigInt(5)
const HUNDRED = BigInt(100)
const SHARE_DISPLAY_DECIMALS = 6

function refuse(reason: string): never {
  throw new ChainActionRefused(`${reason} Nothing was signed or sent.`)
}

function checkVaultCall(vault: ReviewedVault, call: DecodedCall, context: CheckContext): void {
  const { account, approval } = context
  if (call.functionName === 'deposit') {
    const [assets, receiver] = call.args as readonly [bigint, string]
    if (!sameAddress(receiver, account)) refuse('This deposit credits someone else.')
    if (assets <= BigInt(0)) refuse('This deposit is for nothing.')
    if (approval === undefined) return
    if (
      !sameAddress(approval.token, vault.asset.id) ||
      !sameAddress(approval.spender, vault.address)
    ) {
      refuse("This approval doesn't match the vault's own token and address.")
    }
    if (approval.units !== assets) refuse("This approval doesn't match the amount.")
    return
  }
  // A withdraw names assets and a redeem names shares. Both name who is paid and whose position it is.
  const [amount, receiver, owner] = call.args as readonly [bigint, string, string]
  if (!sameAddress(receiver, account)) refuse('This withdrawal pays someone else.')
  if (!sameAddress(owner, account)) refuse("This withdrawal takes from someone else's position.")
  if (amount <= BigInt(0)) refuse('This withdrawal is for nothing.')
  // Euler reads max-uint as a whole balance, and nothing here builds it: a redeem names the shares.
  if (amount === maxUint256) refuse('This withdrawal doesn’t name an amount.')
  if (approval !== undefined) refuse('A withdrawal needs no approval.')
}

export function vaultPolicy(
  venueName: string,
  chain: EvmChain,
  vault: ReviewedVault
): EvmCallPolicy {
  return {
    venueName,
    chain,
    contracts: {
      [vault.address]: {
        abi: VAULT_CALLS,
        functions: ['deposit', 'withdraw', 'redeem'],
        check: (call, context) => checkVaultCall(vault, call, context),
      },
    },
    spenders: [vault.address],
    approvable: [vault.asset.id],
  }
}

/** Whole units, for a figure that moves by the block. */
function roughly(units: bigint, decimals: number): string {
  return Math.floor(Number(formatUnits(units, decimals))).toLocaleString('en-US')
}

function shareAmount(units: bigint, decimals: number): string {
  const [whole = '0', fraction = ''] = formatUnits(units, decimals).split('.')
  const kept = fraction.slice(0, SHARE_DISPLAY_DECIMALS).replace(/0+$/, '')
  return kept === '' ? whole : `${whole}.${kept}`
}

export function createVaultVenue(config: VaultVenueConfig, deps: VaultVenueDeps = {}): ChainVenue {
  const { id, name, chain, vault, notes } = config
  const { asset } = vault
  const chainName = EVM_CHAINS[chain].name
  const policy = vaultPolicy(name, chain, vault)
  const readerNow = (): EvmReaderClient => deps.reader ?? evmReader(chain)

  const readBalance = (reader: EvmReaderClient, token: string, account: string) =>
    reader.readContract({
      address: token as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account as Address],
    })

  /** Reads that must succeed, so a failed one refuses rather than passing as fine. */
  async function mustRead<T>(reading: () => Promise<T>): Promise<T> {
    try {
      return await reading()
    } catch (error) {
      if (error instanceof ChainActionRefused) throw error
      return refuse(`I couldn't read ${vault.name} on ${chainName} just now, so this wasn't built.`)
    }
  }

  function checkedRequest(request: ChainActionRequest, account: string) {
    if (!isAddress(account)) refuse(`That is not ${withArticle(chainName)} account.`)
    const token = tokenBySymbol(EVM_CHAINS[chain].tokens, request.tokenIn)
    if (token === undefined || !sameAddress(token.id, asset.id)) {
      refuse(`${name} takes ${asset.symbol} here, not ${request.tokenIn}.`)
    }
    return { units: BigInt(toBaseUnits(request.amount, asset.decimals)), owner: account as Address }
  }

  /** Everything a deposit needs to stand, read without building anything. */
  async function checkedSupply(
    request: ChainActionRequest,
    account: string,
    reader: EvmReaderClient
  ) {
    const { units, owner } = checkedRequest(request, account)
    const { total, free } = await mustRead(async () => {
      await config.assertAsReviewed(reader)
      const [totalAssets, liquidity] = await Promise.all([
        reader.readContract({
          address: vault.address as Address,
          abi: VAULT_READS,
          functionName: 'totalAssets',
        }),
        config.readLiquidity(reader),
      ])
      return { total: totalAssets, free: liquidity }
    })
    if (free * HUNDRED < total * MIN_FREE_PERCENT) {
      refuse(
        `Only about ${roughly(free, asset.decimals)} of the ${roughly(total, asset.decimals)} ${asset.symbol} in ${vault.name} can be taken out right now, so I won't add to it.`
      )
    }
    let apy: PreparedAction['apy']
    try {
      apy = await config.readApy(reader)
    } catch (error) {
      if (error instanceof ChainActionRefused) throw error
      apy = undefined
    }
    return { units, owner, total, free, apy }
  }

  async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
    if (request.kind !== 'supply') refuse(`${name} only quotes a supply.`)
    const { apy } = await checkedSupply(request, account, readerNow())
    return quotedApy(apy)
  }

  async function prepareSupply(
    request: ChainActionRequest,
    account: string
  ): Promise<PreparedAction> {
    const reader = readerNow()
    const { units, owner, total, free, apy } = await checkedSupply(request, account, reader)
    const { held, shares, room } = await mustRead(async () => {
      const [balance, preview, space] = await Promise.all([
        readBalance(reader, asset.id, owner),
        reader.readContract({
          address: vault.address as Address,
          abi: VAULT_READS,
          functionName: 'previewDeposit',
          args: [units],
        }),
        config.readRoom?.(reader, owner),
      ])
      return { held: balance, shares: preview, room: space }
    })
    if (held < units) {
      refuse(
        `You hold ${formatUnits(held, asset.decimals)} ${asset.symbol}, which is less than ${request.amount}.`
      )
    }
    if (room !== undefined && room < units) {
      refuse(
        `${vault.name} only has room for about ${roughly(room, asset.decimals)} more ${asset.symbol}. Try a smaller amount.`
      )
    }
    const { signing, needsApproval } = await buildEvmCall(
      {
        chain,
        account: owner,
        to: vault.address,
        data: encodeFunctionData({
          abi: VAULT_CALLS,
          functionName: 'deposit',
          args: [units, owner],
        }),
        pull: { token: asset.id, spender: vault.address, units },
      },
      reader
    )
    return {
      venueId: id,
      venueName: name,
      kind: 'supply',
      summary: `Supply ${request.amount} ${asset.symbol} to ${vault.name} on ${name}, curated by ${vault.curator}.`,
      pay: { amount: request.amount, symbol: asset.symbol },
      receive: {
        amount: shareAmount(shares, vault.shareDecimals),
        symbol: vault.shareSymbol,
        approximate: true,
      },
      ...(apy !== undefined ? { apy } : {}),
      notes: [
        ...notes,
        `About ${roughly(free, asset.decimals)} of the ${roughly(total, asset.decimals)} ${asset.symbol} in this vault can be taken out right now. The rest is lent out, so a larger withdrawal has to wait for repayments.`,
        ...(needsApproval ? [approvalNote(name, request.amount, asset.symbol)] : []),
      ],
      signing,
    }
  }

  async function prepareWithdraw(
    request: ChainActionRequest,
    account: string
  ): Promise<PreparedAction> {
    const reader = readerNow()
    const { units, owner } = checkedRequest(request, account)
    const whole = request.wholePosition === true
    const { shares, position } = await mustRead(() => readPosition(reader, owner))
    if (position === BigInt(0)) refuse(`You have no ${asset.symbol} in ${vault.name}.`)
    if (!whole && position < units) {
      refuse(
        `You have about ${formatUnits(position, asset.decimals)} ${asset.symbol} in ${vault.name}, which is less than ${request.amount}.`
      )
    }
    const taken = whole ? position : units
    // A way out must not depend on these readings: if one fails, trying the call below still decides.
    const [free, barred] = await Promise.all([
      config.readLiquidity(reader).catch(() => undefined),
      config.readExitBlock?.(reader, owner).catch(() => undefined),
    ])
    if (barred !== undefined) refuse(`${barred} Your position is still there.`)
    if (free !== undefined && free < taken) {
      refuse(
        `${vault.name} can pay out about ${roughly(free, asset.decimals)} ${asset.symbol} right now, because the rest is lent out. Your position is still there. Try a smaller amount, or try again later.`
      )
    }
    const { signing } = await buildEvmCall(
      {
        chain,
        account: owner,
        to: vault.address,
        // Shares don't accrue, so redeeming all of them leaves nothing, whatever interest has added.
        data: whole
          ? encodeFunctionData({
              abi: VAULT_CALLS,
              functionName: 'redeem',
              args: [shares, owner, owner],
            })
          : encodeFunctionData({
              abi: VAULT_CALLS,
              functionName: 'withdraw',
              args: [units, owner, owner],
            }),
      },
      reader
    ).catch((error: unknown) => {
      if (!(error instanceof ChainActionRefused)) throw error
      return refuse(
        `This would fail on the chain right now: ${vault.name} wouldn't pay this out. Your position is still there. If you borrowed against it in ${name}'s own app, repay that first. Otherwise try a smaller amount, or try again later, and check you have enough for the network fee.`
      )
    })
    const shown = whole ? formatUnits(position, asset.decimals) : request.amount
    return {
      venueId: id,
      venueName: name,
      kind: 'withdraw',
      summary: whole
        ? `Withdraw all of your ${asset.symbol}, about ${shown}, from ${vault.name} on ${name}, back to your own wallet.`
        : `Withdraw ${request.amount} ${asset.symbol} from ${vault.name} on ${name}, back to your own wallet.`,
      pay: { amount: shown, symbol: asset.symbol },
      ...(whole ? { receive: { amount: shown, symbol: asset.symbol, approximate: true } } : {}),
      notes: [
        whole
          ? `This cashes in every share you hold, so nothing stays in the vault. What you get is what those shares are worth when this lands.`
          : 'Whatever you leave in the vault keeps earning, with the same risks as before.',
      ],
      signing,
    }
  }

  async function readPosition(reader: EvmReaderClient, owner: string) {
    const shares = await readBalance(reader, vault.address, owner)
    if (shares === BigInt(0)) return { shares, position: BigInt(0) }
    const position = await reader.readContract({
      address: vault.address as Address,
      abi: VAULT_READS,
      functionName: 'convertToAssets',
      args: [shares],
    })
    return { shares, position }
  }

  /** A failed read throws, since empty would say the money isn't here. */
  async function positions(account: string): Promise<VenuePosition[]> {
    if (!isAddress(account)) refuse(`That is not ${withArticle(chainName)} account.`)
    const { position } = await readPosition(readerNow(), account)
    return position === BigInt(0)
      ? []
      : [
          {
            slot: 'supplied',
            symbol: asset.symbol,
            amount: formatUnits(position, asset.decimals),
          },
        ]
  }

  const followsAs = takesOnly(name, [asset.symbol])

  return {
    id,
    name,
    kinds: ['supply', 'withdraw'],
    positions,
    assertCanFollow: async (step, account) => {
      if (step.kind !== 'supply') refuse(`${name} can only supply after a swap.`)
      await followsAs(step, account)
    },
    quote,
    prepare: async (request, account) => {
      if (request.kind === 'supply') return prepareSupply(request, account)
      if (request.kind === 'withdraw') return prepareWithdraw(request, account)
      return refuse(`${name} can supply and withdraw here, not ${request.kind}.`)
    },
    ...evmCallVenueParts(policy, deps.client),
  }
}
