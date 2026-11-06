import {
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  isAddress,
  type Address,
  type Instruction,
} from '@solana/kit'
import { z } from 'zod'

import { base64FromBytes, bytesFromBase64 } from '../base64'
import {
  ChainActionRefused,
  quotedApy,
  tokenBySymbol,
  toBaseUnits,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
  type SigningPayload,
  type VenuePosition,
  type VenueQuote,
  takesOnly,
} from '../types'
import { readAccounts, tokenAccountAmount } from './accounts'
import {
  assertDepositAmount,
  ASSOCIATED_TOKEN_PROGRAM,
  associatedTokenAccount,
  isSolanaExit,
  solanaAssertSafe,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  type ExitInstructionRule,
} from './assert-safe'
import { JUPITER_API, jupiterHeaders, venueFetch } from './http'
import {
  JUPITER_LEND_ADMIN,
  JUPITER_LEND_MARKETS,
  JUPITER_LEND_POLICY,
  JUPITER_LEND_PROGRAM,
  JUPITER_LIQUIDITY,
  JUPITER_LIQUIDITY_PROGRAM,
  WITHDRAW_DISCRIMINATOR,
} from './programs'
import {
  accountRoles,
  anchorAmountData,
  assertStakeShape,
  compileForSigning,
  computeBudget,
  createTokenAccount,
  createTokenAccountRule,
  readAddress,
  readOnlyRpc,
  readU64,
  type ChainAccount,
  type InstructionRule,
  type SolanaRpc,
  type StakeShape,
} from './stake-pool'
import { fromBaseUnits, SOLANA_TOKENS } from './tokens'

/**
 * Only tokens the wallet already holds as a token account. Its SOL deposit spends
 * from a wrapped SOL account and does not wrap native SOL first, as a live
 * transaction showed, so it would fail for most wallets.
 */
const SUPPORTED = new Set(['USDC', 'USDT'])

const Rates = z.array(
  z.object({
    assetAddress: z.string(),
    supplyRate: z.union([z.string(), z.number()]).optional(),
    rewardsRate: z.union([z.string(), z.number()]).optional(),
  })
)

const Deposit = z.object({ transaction: z.string().min(1) })

/**
 * Percent from a rate. The live API returns whole basis points ("504"), though its
 * docs show a fraction ("0.025"), so both are read, and anything else is no rate.
 */
function ratePercent(rate: string | number | undefined): number | undefined {
  if (rate === undefined || rate === '') return undefined
  const value = Number(rate)
  if (!Number.isFinite(value) || value < 0) return undefined
  const percent = String(rate).includes('.') || value < 1 ? value * 100 : value / 100
  return percent <= 100 ? percent : undefined
}

const CREATE_IDEMPOTENT = 1
/** Where the deposit instruction lists the receipt token account and its mint. */
const RECIPIENT_POSITION = 2
const RECEIPT_MINT_POSITION = 6

/**
 * Puts a step in front of the deposit that opens the wallet's receipt token account.
 *
 * The deposit Jupiter's API returns assumes this account exists. For a first-time
 * depositor it doesn't, and a read-only simulation on 3 November 2026 failed with
 * `AccountNotInitialized` on `recipient_token_account`. Creating it this way is a
 * no-op when it already exists. Its accounts were all listed by the deposit, so
 * nothing new needs a signature, and the message stays unsigned until the wallet.
 */
export function withReceiptAccount(base64: string, account: string): string {
  const { messageBytes } = getTransactionDecoder().decode(bytesFromBase64(base64))
  const message = getCompiledTransactionMessageDecoder().decode(messageBytes)
  if (message.version !== 'legacy' && message.version !== 0) return base64
  const { staticAccounts, instructions } = message
  const programAt = (index: number): string | undefined => staticAccounts[index]
  if (instructions.some((i) => programAt(i.programAddressIndex) === ASSOCIATED_TOKEN_PROGRAM)) {
    return base64
  }

  const deposit = instructions.find(
    (i) => programAt(i.programAddressIndex) === JUPITER_LEND_PROGRAM
  )
  const recipientIndex = deposit?.accountIndices?.[RECIPIENT_POSITION]
  const mintIndex = deposit?.accountIndices?.[RECEIPT_MINT_POSITION]
  const recipient = recipientIndex === undefined ? undefined : staticAccounts[recipientIndex]
  const mint = mintIndex === undefined ? undefined : staticAccounts[mintIndex]
  if (
    recipientIndex === undefined ||
    mintIndex === undefined ||
    recipient === undefined ||
    mint === undefined ||
    recipient !== associatedTokenAccount(account, mint)
  ) {
    throw new ChainActionRefused(
      'This deposit would not pay into your own token account, so I refused it. Nothing was signed or sent.'
    )
  }

  const indexOf = (address: string): number => staticAccounts.indexOf(address as Address)
  const programAddressIndex = indexOf(ASSOCIATED_TOKEN_PROGRAM)
  const systemIndex = indexOf(SYSTEM_PROGRAM)
  const tokenIndex = indexOf(TOKEN_PROGRAM)
  if (programAddressIndex === -1 || systemIndex === -1 || tokenIndex === -1) {
    throw new ChainActionRefused(
      'Jupiter Lend returned a deposit I can’t complete, so nothing was signed or sent. Try again later.'
    )
  }
  const create = {
    programAddressIndex,
    accountIndices: [0, recipientIndex, 0, mintIndex, systemIndex, tokenIndex],
    data: Uint8Array.of(CREATE_IDEMPOTENT),
  }
  const bytes = getCompiledTransactionMessageEncoder().encode({
    ...message,
    instructions: [create, ...instructions],
  })
  const unsigned = new Uint8Array(1 + 64 + bytes.length)
  unsigned[0] = 1
  unsigned.set(bytes, 65)
  return base64FromBytes(unsigned)
}

type Market = (typeof JUPITER_LEND_MARKETS)[number]

const DECIMALS = 6
const U64_MAX = BigInt('18446744073709551615')
/** The program divides by this to turn a share into its token: `docs/earn/cpi.md`. */
const EXCHANGE_PRICE_PRECISION = BigInt(1_000_000_000_000)
/** A simulated withdrawal used under 70,000 units, and opening a token account about 25,000 more. */
const WITHDRAW_COMPUTE_UNITS = 150_000

/** `target/idl/lending.json` in https://github.com/jup-ag/jupiter-lend, the `Lending` account. */
const POOL_DISCRIMINATOR = [135, 199, 82, 16, 249, 131, 182, 241]
const POOL_BYTES = 196
const POOL_MINT_OFFSET = 8
const POOL_RECEIPT_OFFSET = 40
const POOL_REWARDS_MODEL_OFFSET = 75
const POOL_EXCHANGE_PRICE_OFFSET = 115
const POOL_RESERVES_OFFSET = 131
const POOL_SUPPLY_POSITION_OFFSET = 163

interface Pool {
  exchangePrice: bigint
  rewardsModel: string
  reserves: string
  supplyPosition: string
}

function decodePool(account: ChainAccount | null, market: Market): Pool {
  const valid =
    account !== null &&
    account.owner === JUPITER_LEND_PROGRAM &&
    account.data.length === POOL_BYTES &&
    POOL_DISCRIMINATOR.every((byte, at) => account.data[at] === byte) &&
    readAddress(account.data, POOL_MINT_OFFSET) === market.mint &&
    readAddress(account.data, POOL_RECEIPT_OFFSET) === market.receipt &&
    readU64(account.data, POOL_EXCHANGE_PRICE_OFFSET) > BigInt(0)
  if (!valid) {
    throw new ChainActionRefused(
      `Jupiter Lend’s ${market.symbol} pool doesn’t look as expected on chain, so I stopped. Nothing was signed or sent.`
    )
  }
  return {
    exchangePrice: readU64(account.data, POOL_EXCHANGE_PRICE_OFFSET),
    rewardsModel: readAddress(account.data, POOL_REWARDS_MODEL_OFFSET),
    reserves: readAddress(account.data, POOL_RESERVES_OFFSET),
    supplyPosition: readAddress(account.data, POOL_SUPPLY_POSITION_OFFSET),
  }
}

const assetsFor = (shares: bigint, pool: Pool): bigint =>
  (shares * pool.exchangePrice) / EXCHANGE_PRICE_PRECISION

const withdrawRule = (account: string, market: Market): InstructionRule => ({
  program: JUPITER_LEND_PROGRAM,
  prefix: WITHDRAW_DISCRIMINATOR,
  length: 16,
  accountCount: 18,
  accounts: {
    0: account,
    1: associatedTokenAccount(account, market.receipt),
    2: associatedTokenAccount(account, market.mint),
    3: JUPITER_LEND_ADMIN,
    4: market.pool,
    5: market.mint,
    6: market.receipt,
    12: JUPITER_LIQUIDITY,
    13: JUPITER_LIQUIDITY_PROGRAM,
    15: TOKEN_PROGRAM,
    16: ASSOCIATED_TOKEN_PROGRAM,
    17: SYSTEM_PROGRAM,
  },
  also: ({ data }) => readU64(data, 8) > BigInt(0),
})

/** Each withdrawal this venue builds, with only the person's own accounts on either end. */
export function jupiterLendExitShapes(account: string): readonly StakeShape[] {
  return JUPITER_LEND_MARKETS.map((market) => ({
    rules: [createTokenAccountRule(account, market.mint), withdrawRule(account, market)],
  }))
}

const EXIT_RULES: readonly ExitInstructionRule[] = [
  {
    program: JUPITER_LEND_PROGRAM,
    discriminator: WITHDRAW_DISCRIMINATOR,
    signers: [0],
    recipient: 2,
  },
]

/**
 * The pool's accounts, in the order of `withdraw` in `target/idl/lending.json`. The seeds are from
 * `docs/earn/cpi.md` and Jupiter's SDK, and a live test holds the result to what Jupiter's API builds.
 */
async function withdrawInstruction(
  account: string,
  market: Market,
  pool: Pool,
  amount: bigint
): Promise<Instruction> {
  const { readonly, signer, writable } = accountRoles
  const encoder = getAddressEncoder()
  const programAddress = JUPITER_LIQUIDITY_PROGRAM as Address
  const mintSeed = encoder.encode(market.mint as Address)
  const [[rateModel], [claim]] = await Promise.all([
    getProgramDerivedAddress({ programAddress, seeds: ['rate_model', mintSeed] }),
    getProgramDerivedAddress({
      programAddress,
      seeds: ['user_claim', encoder.encode(JUPITER_LEND_ADMIN as Address), mintSeed],
    }),
  ])
  return {
    programAddress: JUPITER_LEND_PROGRAM as Address,
    accounts: [
      signer(account),
      writable(associatedTokenAccount(account, market.receipt)),
      writable(associatedTokenAccount(account, market.mint)),
      readonly(JUPITER_LEND_ADMIN),
      writable(market.pool),
      readonly(market.mint),
      writable(market.receipt),
      writable(pool.reserves),
      writable(pool.supplyPosition),
      readonly(rateModel),
      writable(associatedTokenAccount(JUPITER_LIQUIDITY, market.mint)),
      writable(claim),
      writable(JUPITER_LIQUIDITY),
      readonly(JUPITER_LIQUIDITY_PROGRAM),
      readonly(pool.rewardsModel),
      readonly(TOKEN_PROGRAM),
      readonly(ASSOCIATED_TOKEN_PROGRAM),
      readonly(SYSTEM_PROGRAM),
    ],
    data: anchorAmountData(WITHDRAW_DISCRIMINATOR, amount),
  }
}

export interface JupiterLendOptions {
  env?: Record<string, string | undefined>
  retryDelayMs?: number
  rpc?: SolanaRpc
}

export function createJupiterLendVenue(options: JupiterLendOptions = {}): ChainVenue {
  const env = options.env ?? process.env
  const rpc = options.rpc ?? readOnlyRpc(env)
  const shared = {
    label: 'Jupiter',
    headers: jupiterHeaders(env),
    ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
  }

  /** Each pool as it stands, and the shares this account holds in it, read from the chain. */
  async function readHoldings(account: string, markets: readonly Market[]) {
    const accounts = await readAccounts(
      rpc,
      markets.flatMap((market) => [market.pool, associatedTokenAccount(account, market.receipt)])
    )
    return markets.map((market, i) => {
      const pool = decodePool(accounts[i * 2] ?? null, market)
      return { market, pool, shares: tokenAccountAmount(accounts[i * 2 + 1] ?? null) }
    })
  }

  /**
   * Priced at the rate the pool stored at its last update, which every deposit and withdrawal
   * refreshes. Interest since then isn't counted, so this can read a little under the true figure.
   */
  async function positions(account: string): Promise<VenuePosition[]> {
    if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
    const holdings = await readHoldings(account, JUPITER_LEND_MARKETS)
    return holdings.flatMap(({ market, pool, shares }) => {
      const assets = assetsFor(shares, pool)
      return assets === BigInt(0)
        ? []
        : [
            {
              slot: 'supplied' as const,
              symbol: market.symbol,
              amount: fromBaseUnits(assets.toString(), DECIMALS),
            },
          ]
    })
  }

  /**
   * Built here from the chain alone, so this exit needs no company server. Whole positions use the
   * program's own "everything" value, which leaves no interest behind: `docs/earn/sdk.md`.
   */
  async function prepareWithdraw(
    request: ChainActionRequest,
    account: string
  ): Promise<PreparedAction> {
    if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
    const wanted = request.tokenIn.trim().toUpperCase()
    const market = JUPITER_LEND_MARKETS.find((m) => m.symbol === wanted)
    if (market === undefined) {
      throw new ChainActionRefused(
        `Jupiter Lend here pays back USDC or USDT, not ${request.tokenIn}. Try "withdraw 10 USDC from Jupiter Lend". Nothing was signed or sent.`
      )
    }
    const amount = BigInt(toBaseUnits(request.amount, DECIMALS))
    const [holding] = await readHoldings(account, [market])
    const worth = holding === undefined ? BigInt(0) : assetsFor(holding.shares, holding.pool)
    if (holding === undefined || holding.shares === BigInt(0)) {
      throw new ChainActionRefused(
        `You have no ${market.symbol} on Jupiter Lend. Nothing was signed or sent.`
      )
    }
    const whole = request.wholePosition === true
    if (!whole && amount > worth) {
      throw new ChainActionRefused(
        `You have about ${fromBaseUnits(worth.toString(), DECIMALS)} ${market.symbol} on Jupiter Lend, which is less than ${request.amount}. Nothing was signed or sent.`
      )
    }

    const transaction = await compileForSigning(rpc, account, [
      ...computeBudget(WITHDRAW_COMPUTE_UNITS),
      createTokenAccount(account, market.mint),
      await withdrawInstruction(account, market, holding.pool, whole ? U64_MAX : amount),
    ])
    const paid = whole ? fromBaseUnits(worth.toString(), DECIMALS) : request.amount
    return {
      venueId: 'jupiter-lend',
      venueName: 'Jupiter Lend Earn',
      kind: 'withdraw',
      summary: whole
        ? `Withdraw all your ${market.symbol} from Jupiter Lend Earn to your wallet, about ${paid} with interest.`
        : `Withdraw ${paid} ${market.symbol} from Jupiter Lend Earn to your wallet.`,
      pay: { amount: paid, symbol: market.symbol },
      receive: { amount: paid, symbol: market.symbol, approximate: whole },
      notes: [
        'This calls Jupiter Lend’s contract directly from your wallet, with no Jupiter server involved.',
        'Only money not lent out can leave, and the contract limits how much can leave at once. If too little is free right now, the network rejects this, nothing moves, and you lose only the small network fee.',
        'It needs a little SOL for the network fee, and about 0.002 SOL more if your wallet has no account for this token yet.',
      ],
      signing: { family: 'solana', transaction },
    }
  }

  async function readApy(mint: string): Promise<PreparedAction['apy']> {
    const { status, body } = await venueFetch(`${JUPITER_API}/lend/v1/earn/tokens`, shared).catch(
      () => ({ status: 0, body: undefined })
    )
    const rates = Rates.safeParse(body)
    if (status !== 200 || !rates.success) return undefined
    const entry = rates.data.find((r) => r.assetAddress === mint)
    const basePercent = ratePercent(entry?.supplyRate)
    if (basePercent === undefined) return undefined
    const rewardPercent = ratePercent(entry?.rewardsRate)
    return rewardPercent === undefined || rewardPercent === 0
      ? { basePercent }
      : { basePercent, rewardPercent }
  }

  function checkedDeposit(
    request: ChainActionRequest,
    account: string
  ): { token: ChainToken; amount: string } {
    if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
    const token = tokenBySymbol(SOLANA_TOKENS, request.tokenIn)
    if (request.kind !== 'supply' || token === undefined || !SUPPORTED.has(token.symbol)) {
      throw new ChainActionRefused(
        `Jupiter Lend here takes USDC or USDT deposits only, not ${request.tokenIn}. Try "supply 10 USDC on Jupiter Lend".`
      )
    }
    return { token, amount: toBaseUnits(request.amount, token.decimals) }
  }

  async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
    const { token } = checkedDeposit(request, account)
    return quotedApy(await readApy(token.id))
  }

  async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
    if (request.kind === 'withdraw') return prepareWithdraw(request, account)
    const { token, amount } = checkedDeposit(request, account)

    const apy = await readApy(token.id)
    const { status, body } = await venueFetch(`${JUPITER_API}/lend/v1/earn/deposit`, {
      ...shared,
      method: 'POST',
      body: { asset: token.id, amount, signer: account },
    })
    const deposit = Deposit.safeParse(body)
    if (status !== 200 || !deposit.success) {
      throw new ChainActionRefused(
        'Jupiter Lend could not build this deposit right now. Nothing was signed or sent, so try again in a moment.'
      )
    }
    assertDepositAmount(deposit.data.transaction, JUPITER_LEND_PROGRAM, amount)
    const transaction = withReceiptAccount(deposit.data.transaction, account)

    return {
      venueId: 'jupiter-lend',
      venueName: 'Jupiter Lend Earn',
      kind: 'supply',
      summary: `Deposit ${request.amount} ${token.symbol} into Jupiter Lend Earn, where it is lent to borrowers.`,
      pay: { amount: request.amount, symbol: token.symbol },
      apy,
      notes: [
        `Jupiter labels this API beta, and ${apy === undefined ? 'I couldn’t read the current rate just now. The rate' : 'the rate shown is today’s. It'} changes with borrowing demand and is not a promise.`,
        'Your deposit is lent out through smart contracts. Those can fail, and vault collateral is not fully isolated from other markets on Jupiter Lend, so you could lose money.',
        'Withdrawals depend on available liquidity and can be delayed when borrowing is high. A first deposit also pays about 0.002 SOL to open the token account holding your position.',
      ],
      signing: { family: 'solana', transaction },
    }
  }

  return {
    id: 'jupiter-lend',
    name: 'Jupiter Lend Earn',
    kinds: ['supply', 'withdraw'],
    assertCanFollow: takesOnly('Jupiter Lend', [...SUPPORTED]),
    quote,
    prepare,
    positions,
    assertSafe: (payload: SigningPayload, account: string) =>
      isSolanaExit(payload, EXIT_RULES)
        ? assertStakeShape(payload, account, 'Jupiter Lend', jupiterLendExitShapes(account))
        : solanaAssertSafe(JUPITER_LEND_POLICY)(payload, account),
  }
}
