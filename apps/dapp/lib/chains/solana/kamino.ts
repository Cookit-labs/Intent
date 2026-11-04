import { isAddress } from '@solana/kit'
import { z } from 'zod'

import {
  ChainActionRefused,
  quotedApy,
  tokenBySymbol,
  toBaseUnits,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
  type VenueQuote,
  takesOnly,
} from '../types'
import { assertDepositAmount, solanaAssertSafe } from './assert-safe'
import { venueFetch } from './http'
import { KAMINO_POLICY, KVAULT_PROGRAM } from './programs'
import { fromBaseUnits, SOLANA_TOKENS } from './tokens'

const KAMINO_API = 'https://api.kamino.finance'
const VAULT_CACHE_MS = 5 * 60_000
const USDC = 'USDC'

const Vault = z.object({
  address: z.string(),
  programId: z.string().optional(),
  state: z.object({
    name: z.string().optional(),
    tokenMint: z.string(),
    prevAum: z.string(),
    minDepositAmount: z.string().optional(),
  }),
})
type Vault = z.infer<typeof Vault>

const Metrics = z.object({
  apy: z.string(),
  apyFarmRewards: z.string().optional(),
  apyIncentives: z.string().optional(),
  apyReservesIncentives: z.string().optional(),
})

const Deposit = z.object({ transaction: z.string().min(1) })

/**
 * The USDC vault to use: the one holding the most, by assets under management.
 *
 * Deliberately not the highest rate. Rates spike and fall within days, one vault
 * went from about 5% to under 3% in a month, and a rate is what a thin or
 * risk-taking vault can offer most easily. How much depositors have put in moves
 * slowly and is costly to fake. It is not a safety rating, so the note and summary
 * name the vault for the user to judge.
 *
 * Only vaults on Kamino's mainnet kVault program count, so a staging deployment
 * in the same list can't be chosen.
 */
export function chooseUsdcVault(vaults: readonly Vault[], usdcMint: string): Vault | undefined {
  let best: Vault | undefined
  let bestAum = 0
  for (const vault of vaults) {
    if (vault.state.tokenMint !== usdcMint) continue
    if (vault.programId !== undefined && vault.programId !== KVAULT_PROGRAM) continue
    const aum = Number(vault.state.prevAum)
    if (Number.isFinite(aum) && aum > bestAum) {
      best = vault
      bestAum = aum
    }
  }
  return best
}

/** A vault's name is set on chain by whoever runs it, so only plain characters get shown. */
function displayName(vault: Vault): string {
  const cleaned = (vault.state.name ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N} ._+-]/gu, '')
    .trim()
    .slice(0, 40)
  return cleaned === '' ? `vault ${vault.address.slice(0, 6)}` : cleaned
}

function percent(fraction: string | undefined): number {
  const value = Number(fraction)
  return Number.isFinite(value) && value > 0 ? value * 100 : 0
}

export interface KaminoOptions {
  cacheMs?: number
}

export function createKaminoVenue(options: KaminoOptions = {}): ChainVenue {
  const cacheMs = options.cacheMs ?? VAULT_CACHE_MS
  let cached: { at: number; vaults: Vault[] } | undefined

  async function readVaults(): Promise<Vault[]> {
    if (cached !== undefined && Date.now() - cached.at < cacheMs) return cached.vaults
    const { status, body } = await venueFetch(`${KAMINO_API}/kvaults/vaults`, { label: 'Kamino' })
    const vaults = z.array(z.unknown()).safeParse(body)
    if (status !== 200 || !vaults.success) {
      throw new ChainActionRefused(
        'Kamino’s vault list is unavailable right now. Nothing was signed or sent, so try again in a moment.'
      )
    }
    const parsed = vaults.data.flatMap((entry) => {
      const vault = Vault.safeParse(entry)
      return vault.success ? [vault.data] : []
    })
    cached = { at: Date.now(), vaults: parsed }
    return parsed
  }

  async function readApy(address: string): Promise<PreparedAction['apy']> {
    const { status, body } = await venueFetch(`${KAMINO_API}/kvaults/vaults/${address}/metrics`, {
      label: 'Kamino',
    }).catch(() => ({ status: 0, body: undefined }))
    const metrics = Metrics.safeParse(body)
    if (status !== 200 || !metrics.success) return undefined
    const { apy, apyFarmRewards, apyIncentives, apyReservesIncentives } = metrics.data
    const basePercent = percent(apy)
    if (basePercent === 0) return undefined
    const rewardPercent =
      percent(apyFarmRewards) + percent(apyIncentives) + percent(apyReservesIncentives)
    return rewardPercent === 0 ? { basePercent } : { basePercent, rewardPercent }
  }

  /** The vault a deposit would use, after every check that needs no transaction. */
  async function checkedDeposit(
    request: ChainActionRequest,
    account: string
  ): Promise<{ token: ChainToken; amount: string; vault: Vault }> {
    if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
    const token = tokenBySymbol(SOLANA_TOKENS, request.tokenIn)
    if (request.kind !== 'supply' || token === undefined || token.symbol !== USDC) {
      throw new ChainActionRefused(
        `Kamino here takes USDC deposits only, not ${request.tokenIn}. Try "supply 10 USDC on Kamino".`
      )
    }
    const amount = toBaseUnits(request.amount, token.decimals)

    const vault = chooseUsdcVault(await readVaults(), token.id)
    if (vault === undefined) {
      throw new ChainActionRefused(
        'I couldn’t find a Kamino USDC vault right now. Nothing was signed or sent, so try again in a moment.'
      )
    }
    const minimum = vault.state.minDepositAmount
    if (minimum !== undefined && /^\d+$/.test(minimum) && BigInt(amount) < BigInt(minimum)) {
      throw new ChainActionRefused(
        `This vault takes at least ${fromBaseUnits(minimum, token.decimals)} USDC. Try a larger amount.`
      )
    }
    return { token, amount, vault }
  }

  async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
    const { vault } = await checkedDeposit(request, account)
    return quotedApy(await readApy(vault.address))
  }

  async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
    const { token, amount, vault } = await checkedDeposit(request, account)
    const apy = await readApy(vault.address)
    const { status, body } = await venueFetch(`${KAMINO_API}/ktx/kvault/deposit`, {
      label: 'Kamino',
      method: 'POST',
      body: { wallet: account, kvault: vault.address, amount: request.amount },
    })
    const deposit = Deposit.safeParse(body)
    if (status !== 200 || !deposit.success) {
      throw new ChainActionRefused(
        'Kamino could not build this deposit right now. Nothing was signed or sent. Check your USDC and SOL balances, then try again.'
      )
    }
    assertDepositAmount(deposit.data.transaction, KVAULT_PROGRAM, amount)

    const name = displayName(vault)
    return {
      venueId: 'kamino',
      venueName: 'Kamino Earn',
      kind: 'supply',
      summary: `Deposit ${request.amount} USDC into Kamino's "${name}" vault, currently its largest USDC vault by deposits.`,
      pay: { amount: request.amount, symbol: USDC },
      apy,
      notes: [
        `"${name}" is run by a curator who decides where its funds are lent. Being the largest vault is not a safety rating, and you could lose money if a market or smart contract fails.`,
        `${apy === undefined ? 'I couldn’t read the current rate just now, and the rate' : 'The rate'} changes often and is not a promise.`,
        'Withdrawals depend on available liquidity and can be delayed when markets are stressed.',
      ],
      signing: { family: 'solana', transaction: deposit.data.transaction },
    }
  }

  return {
    id: 'kamino',
    name: 'Kamino Earn',
    kinds: ['supply'],
    assertCanFollow: takesOnly('Kamino', ['USDC']),
    quote,
    prepare,
    assertSafe: solanaAssertSafe(KAMINO_POLICY),
  }
}
