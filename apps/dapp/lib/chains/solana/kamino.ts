import { getAddressEncoder, getProgramDerivedAddress, isAddress, type Address } from '@solana/kit'
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
  type VenuePosition,
  type VenueQuote,
  takesOnly,
} from '../types'
import { readAccounts, tokenAccountAmount } from './accounts'
import {
  assertDepositAmount,
  assertExitAccounts,
  assertExitAmount,
  associatedTokenAccount,
  decodeSolanaTransaction,
  readLittleEndian,
  solanaEarnAssertSafe,
  SYSTEM_PROGRAM,
} from './assert-safe'
import { venueFetch } from './http'
import {
  KAMINO_EXIT_POLICY,
  KAMINO_POLICY,
  KFARMS_PROGRAM,
  KFARMS_UNSTAKE,
  KVAULT_GLOBAL_CONFIG,
  KVAULT_PROGRAM,
} from './programs'
import { readAddress, readOnlyRpc, readU64, type SolanaRpc } from './stake-pool'
import { fromBaseUnits, SOLANA_TOKENS } from './tokens'

const KAMINO_API = 'https://api.kamino.finance'
const VAULT_CACHE_MS = 5 * 60_000
const USDC = 'USDC'
const USDC_DECIMALS = 6

const U64_MAX = BigInt('18446744073709551615')
/** Where amounts are scaled: `prev_aum_sf` by 2^60, a farm's stake by 10^18. */
const SCALE_BITS = BigInt(60)
const FARM_STAKE_SCALE = BigInt(10) ** BigInt(18)
const BPS = BigInt(10_000)

/**
 * `VaultState`, `src/idl/kvault.json` in https://github.com/Kamino-Finance/klend-sdk. Each field was
 * checked on 5 November 2026 against the same vault in Kamino's API, and a live test keeps doing so.
 */
const VAULT_MINT_OFFSET = 80
const VAULT_SHARES_MINT_OFFSET = 184
const VAULT_SHARES_DECIMALS_OFFSET = 216
const VAULT_SHARES_ISSUED_OFFSET = 232
const VAULT_AUM_OFFSET = 280
const VAULT_MIN_WITHDRAW_OFFSET = 58416
const VAULT_NAME_OFFSET = 58528
const VAULT_NAME_BYTES = 40
const VAULT_FARM_OFFSET = 58600
const VAULT_PENALTY_LAMPORTS_OFFSET = 58680
const VAULT_PENALTY_BPS_OFFSET = 58688
const VAULT_MIN_BYTES = VAULT_PENALTY_BPS_OFFSET + 8

const GLOBAL_PENALTY_LAMPORTS_OFFSET = 72
const GLOBAL_PENALTY_BPS_OFFSET = 80

/** `UserState` in Kamino's farms program. The owner's field was checked against a live stake. */
const FARM_USER_OWNER_OFFSET = 48
const FARM_USER_STAKE_OFFSET = 408

const UserPositions = z.array(z.object({ vaultAddress: z.string() }))
const Simulation = z.object({ value: z.object({ err: z.unknown() }) })

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
function displayName(name: string | undefined, address: string): string {
  const cleaned = (name ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N} ._+-]/gu, '')
    .trim()
    .slice(0, 40)
  return cleaned === '' ? `vault ${address.slice(0, 6)}` : cleaned
}

function percent(fraction: string | undefined): number {
  const value = Number(fraction)
  return Number.isFinite(value) && value > 0 ? value * 100 : 0
}

const u128 = (data: Uint8Array, offset: number): bigint => readLittleEndian(data, offset, 16)
const larger = (a: bigint, b: bigint): bigint => (a > b ? a : b)

/** What a person holds in one vault, read from the chain. */
export interface KaminoHolding {
  vault: string
  name: string
  shares: bigint
  sharesDecimals: number
  sharesIssued: bigint
  aumScaled: bigint
  minWithdraw: bigint
  penaltyLamports: bigint
  penaltyBps: bigint
  /** What these shares would pay now, after the vault's charge. */
  net: bigint
}

/** `buildInstantWithdrawPlan` in the SDK: the larger of a flat charge and a percentage. */
function chargeOn(gross: bigint, lamports: bigint, bps: bigint): bigint {
  return larger(lamports, (gross * bps + BPS - BigInt(1)) / BPS)
}

/**
 * The shares that pay at least this much after the charge, rounding up. A rate read a little behind
 * the true one only ever makes this slightly more shares, so the person never gets short-changed.
 */
export function sharesForNet(holding: KaminoHolding, net: bigint): bigint {
  const { penaltyLamports, penaltyBps, sharesIssued, aumScaled } = holding
  const gross = larger(
    net + penaltyLamports,
    (net * BPS + BPS - penaltyBps - BigInt(1)) / (BPS - penaltyBps)
  )
  const numerator = (gross * sharesIssued) << SCALE_BITS
  return (numerator + aumScaled - BigInt(1)) / aumScaled
}

/** Refuses a build whose farm step takes out more than the withdrawal uses. */
function assertUnstakeWithin(base64: string, shares: bigint): void {
  const transaction = decodeSolanaTransaction(base64)
  let unstaked = BigInt(0)
  for (const { programIndex, data } of transaction.instructions) {
    const prefix = Array.from(data.subarray(0, 8), (byte) => byte.toString(16).padStart(2, '0'))
    if (
      transaction.staticAccounts[programIndex] === KFARMS_PROGRAM &&
      prefix.join('') === KFARMS_UNSTAKE
    ) {
      unstaked += u128(data, 8)
    }
  }
  if (unstaked > shares * FARM_STAKE_SCALE) {
    throw new ChainActionRefused(
      'This withdrawal would unstake more of your Kamino shares than you asked for. Nothing was signed or sent.'
    )
  }
}

export interface KaminoOptions {
  cacheMs?: number
  env?: Record<string, string | undefined>
  rpc?: SolanaRpc
}

export function createKaminoVenue(options: KaminoOptions = {}): ChainVenue {
  const cacheMs = options.cacheMs ?? VAULT_CACHE_MS
  const rpc = options.rpc ?? readOnlyRpc(options.env)
  const usdcMint = tokenBySymbol(SOLANA_TOKENS, USDC)?.id
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

  /**
   * Which vaults to look in comes from Kamino's API, since there are over a hundred USDC vaults and
   * the one a deposit chose can stop being the largest. Every figure then comes from the chain.
   * Largest first, because that is the one a request for the whole of it empties.
   */
  async function readHoldings(account: string): Promise<KaminoHolding[]> {
    if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
    const { status, body } = await venueFetch(`${KAMINO_API}/kvaults/users/${account}/positions`, {
      label: 'Kamino',
    })
    const listed = UserPositions.safeParse(body)
    if (status !== 200 || !listed.success) {
      throw new ChainActionRefused(
        'Kamino couldn’t say which vaults you are in just now. Nothing was signed or sent, so try again in a moment.'
      )
    }
    const addresses = [...new Set(listed.data.map((p) => p.vaultAddress))].filter((a) =>
      isAddress(a)
    )
    if (addresses.length === 0) return []

    const [config, ...read] = await readAccounts(rpc, [KVAULT_GLOBAL_CONFIG, ...addresses])
    if (
      config === null ||
      config === undefined ||
      config.owner !== KVAULT_PROGRAM ||
      config.data.length < GLOBAL_PENALTY_BPS_OFFSET + 8
    ) {
      throw new ChainActionRefused(
        'Kamino’s settings don’t look as expected on chain, so I stopped. Nothing was signed or sent.'
      )
    }

    const encoder = getAddressEncoder()
    const vaults = addresses.flatMap((address, i) => {
      const state = read[i]
      if (
        state === null ||
        state === undefined ||
        state.owner !== KVAULT_PROGRAM ||
        state.data.length < VAULT_MIN_BYTES ||
        readAddress(state.data, VAULT_MINT_OFFSET) !== usdcMint
      ) {
        return []
      }
      return [{ address, data: state.data }]
    })
    if (vaults.length === 0) return []

    const owned = await Promise.all(
      vaults.map(async ({ data }) => {
        const farm = readAddress(data, VAULT_FARM_OFFSET)
        const sharesAccount = associatedTokenAccount(
          account,
          readAddress(data, VAULT_SHARES_MINT_OFFSET)
        )
        if (farm === SYSTEM_PROGRAM) return { sharesAccount, farmUser: undefined }
        const [farmUser] = await getProgramDerivedAddress({
          programAddress: KFARMS_PROGRAM as Address,
          seeds: ['user', encoder.encode(farm as Address), encoder.encode(account as Address)],
        })
        return { sharesAccount, farmUser: farmUser as string }
      })
    )
    const held = await readAccounts(
      rpc,
      owned.flatMap(({ sharesAccount, farmUser }) => [sharesAccount, farmUser ?? SYSTEM_PROGRAM])
    )

    const decoder = new TextDecoder()
    const holdings = vaults.flatMap(({ address, data }, i) => {
      const inWallet = tokenAccountAmount(held[i * 2] ?? null)
      const farmUser = owned[i]?.farmUser === undefined ? null : (held[i * 2 + 1] ?? null)
      const stakedByPerson =
        farmUser !== null &&
        farmUser.owner === KFARMS_PROGRAM &&
        farmUser.data.length >= FARM_USER_STAKE_OFFSET + 16 &&
        readAddress(farmUser.data, FARM_USER_OWNER_OFFSET) === account
      const staked =
        farmUser !== null && stakedByPerson
          ? u128(farmUser.data, FARM_USER_STAKE_OFFSET) / FARM_STAKE_SCALE
          : BigInt(0)
      const shares = inWallet + staked
      const sharesIssued = readU64(data, VAULT_SHARES_ISSUED_OFFSET)
      const aumScaled = u128(data, VAULT_AUM_OFFSET)
      if (shares === BigInt(0) || sharesIssued === BigInt(0) || aumScaled === BigInt(0)) return []

      const penaltyLamports = larger(
        readU64(data, VAULT_PENALTY_LAMPORTS_OFFSET),
        readU64(config.data, GLOBAL_PENALTY_LAMPORTS_OFFSET)
      )
      const penaltyBps = larger(
        readU64(data, VAULT_PENALTY_BPS_OFFSET),
        readU64(config.data, GLOBAL_PENALTY_BPS_OFFSET)
      )
      const gross = ((shares * aumScaled) >> SCALE_BITS) / sharesIssued
      const charge = chargeOn(gross, penaltyLamports, penaltyBps)
      const net = gross > charge ? gross - charge : BigInt(0)
      if (net === BigInt(0) || penaltyBps >= BPS) return []
      const name = decoder.decode(
        data.subarray(VAULT_NAME_OFFSET, VAULT_NAME_OFFSET + VAULT_NAME_BYTES)
      )
      return [
        {
          vault: address,
          name: displayName(name.replace(/\0+$/, ''), address),
          shares,
          sharesDecimals: Number(readU64(data, VAULT_SHARES_DECIMALS_OFFSET)),
          sharesIssued,
          aumScaled,
          minWithdraw: readU64(data, VAULT_MIN_WITHDRAW_OFFSET),
          penaltyLamports,
          penaltyBps,
          net,
        },
      ]
    })
    return holdings.sort((a, b) => (a.net === b.net ? 0 : a.net > b.net ? -1 : 1))
  }

  async function positions(account: string): Promise<VenuePosition[]> {
    return (await readHoldings(account)).map((holding) => ({
      slot: 'supplied' as const,
      symbol: USDC,
      amount: fromBaseUnits(holding.net.toString(), USDC_DECIMALS),
    }))
  }

  /** Whether the chain would reject this now. A simulation that can't run must block nothing. */
  async function isRejected(transaction: string): Promise<boolean | undefined> {
    try {
      const reply = Simulation.safeParse(
        await rpc('simulateTransaction', [
          transaction,
          {
            encoding: 'base64',
            sigVerify: false,
            replaceRecentBlockhash: true,
            commitment: 'confirmed',
          },
        ])
      )
      return reply.success ? reply.data.value.err !== null : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Built by Kamino's API. The vault program can be called without it: Kamino's docs show how with
   * their SDK, which needs each reserve's state to plan where the money comes from. That planning
   * isn't reproduced here, so this exit stops working if Kamino's API does.
   */
  async function prepareWithdraw(
    request: ChainActionRequest,
    account: string
  ): Promise<PreparedAction> {
    if (request.tokenIn.trim().toUpperCase() !== USDC) {
      throw new ChainActionRefused(
        `Kamino here pays back USDC only, not ${request.tokenIn}. Try "withdraw 10 USDC from Kamino". Nothing was signed or sent.`
      )
    }
    const amount = BigInt(toBaseUnits(request.amount, USDC_DECIMALS))
    const holdings = await readHoldings(account)
    const [largest] = holdings
    if (largest === undefined) {
      throw new ChainActionRefused('You have no USDC on Kamino. Nothing was signed or sent.')
    }
    const whole = request.wholePosition === true
    const holding = whole ? largest : holdings.find((h) => h.net >= amount)
    if (holding === undefined) {
      throw new ChainActionRefused(
        `Your largest Kamino USDC vault holds about ${fromBaseUnits(largest.net.toString(), USDC_DECIMALS)} USDC, which is less than ${request.amount}. Try that amount, then withdraw again. Nothing was signed or sent.`
      )
    }
    if ((whole ? holding.net : amount) <= holding.minWithdraw) {
      throw new ChainActionRefused(
        `This Kamino vault only pays out more than ${fromBaseUnits(holding.minWithdraw.toString(), USDC_DECIMALS)} USDC at a time, so this can't leave as it stands. Nothing was signed or sent.`
      )
    }

    const shares = whole ? holding.shares : sharesForNet(holding, amount)
    const everything = shares >= holding.shares
    // Kamino's docs give the "everything" value in base units, but its API reads this in whole
    // shares and refused that form on 5 November 2026, so the same value is sent in whole shares.
    const asked = everything ? U64_MAX : shares
    const build = async (): Promise<string> => {
      const { status, body } = await venueFetch(`${KAMINO_API}/ktx/kvault/withdraw`, {
        label: 'Kamino',
        method: 'POST',
        body: {
          wallet: account,
          kvault: holding.vault,
          amount: fromBaseUnits(asked.toString(), holding.sharesDecimals),
        },
      })
      const built = Deposit.safeParse(body)
      if (status !== 200 || !built.success) {
        throw new ChainActionRefused(
          'Kamino could not build this withdrawal right now. Nothing was signed or sent, so try again in a moment.'
        )
      }
      assertExitAccounts(built.data.transaction, account, KAMINO_EXIT_POLICY)
      assertExitAmount(built.data.transaction, KAMINO_EXIT_POLICY.rules, asked)
      assertUnstakeWithin(built.data.transaction, asked)
      return built.data.transaction
    }

    // A vault's keeper moves its cash into lending markets every few minutes, and on 5 November 2026
    // Kamino's API built withdrawals from cash the vault no longer had, which the chain rejects at
    // the person's cost. So each build is tried here first, and a rejected one is built once more.
    let transaction = await build()
    if ((await isRejected(transaction)) === true) {
      transaction = await build()
      if ((await isRejected(transaction)) === true) {
        throw new ChainActionRefused(
          'Kamino’s vault can’t pay this out at the moment, usually because its cash is being moved between lending markets. Nothing was signed or sent, so try again in a few minutes.'
        )
      }
    }

    const paid = everything ? holding.net : amount
    const charge = chargeOn(
      (paid * BPS) / (BPS - holding.penaltyBps),
      holding.penaltyLamports,
      holding.penaltyBps
    )
    const others = holdings.filter((h) => h !== holding)
    const paidText = fromBaseUnits(paid.toString(), USDC_DECIMALS)
    return {
      venueId: 'kamino',
      venueName: 'Kamino Earn',
      kind: 'withdraw',
      summary: everything
        ? `Withdraw everything from Kamino's "${holding.name}" vault to your wallet, about ${paidText} USDC with interest.`
        : `Withdraw about ${paidText} USDC from Kamino's "${holding.name}" vault to your wallet.`,
      pay: { amount: paidText, symbol: USDC },
      receive: { amount: paidText, symbol: USDC, approximate: true },
      notes: [
        ...(charge > BigInt(0)
          ? [
              `Kamino keeps about ${fromBaseUnits(charge.toString(), USDC_DECIMALS)} USDC of this as a withdrawal charge, read on chain. The amount shown is after it.`,
            ]
          : []),
        'Kamino’s own server builds this transaction. I check that it pays only your wallet, but this withdrawal can’t be built here if that server is down.',
        'Only money the vault can get back from its lending markets can leave. If too little is free right now, the network rejects this, nothing moves, and you lose only the small network fee.',
        ...others.map(
          (other) =>
            `You also have about ${fromBaseUnits(other.net.toString(), USDC_DECIMALS)} USDC in Kamino's "${other.name}" vault. This doesn’t touch it, so withdraw again for that.`
        ),
      ],
      signing: { family: 'solana', transaction },
    }
  }

  async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
    if (request.kind === 'withdraw') return prepareWithdraw(request, account)
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

    const name = displayName(vault.state.name, vault.address)
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
    kinds: ['supply', 'withdraw'],
    assertCanFollow: takesOnly('Kamino', ['USDC']),
    quote,
    prepare,
    positions,
    assertSafe: solanaEarnAssertSafe(KAMINO_POLICY, KAMINO_EXIT_POLICY),
  }
}
