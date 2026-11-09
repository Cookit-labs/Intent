import {
  decodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  isAddress,
  maxUint256,
  parseAbi,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'

import {
  ChainActionRefused,
  quotedApy,
  takesOnly,
  tokenBySymbol,
  toBaseUnits,
  type ChainActionRequest,
  type ChainToken,
  type FollowOnStep,
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
import { AVALANCHE_TOKENS, EVM_CHAINS, EVM_NATIVE_ID, MONAD_TOKENS, type EvmChain } from './tokens'

/**
 * Aave V3's Pool, called directly, on Avalanche and Monad, and Neverland's main market on Monad,
 * which is built from the same code. The person is always the one credited, paid or in debt.
 * Debt is variable rate only. Neverland's isolated markets and self-repay vaults are not used.
 */

/** A borrow, or a withdraw of collateral, may not leave the account's health factor under this. */
export const MIN_HEALTH_FACTOR = 1.5
const MIN_HEALTH_BPS = BigInt(15_000)
const VARIABLE_RATE = BigInt(2)
const SECONDS_PER_YEAR = 31_536_000
const RAY = 1e27
/** Oracle prices are USD with eight decimals. BASE_CURRENCY_UNIT reads 1e8 on all three markets. */
const ORACLE_UNIT = 1e8
/**
 * What a whole repay names over the debt, for interest that adds before it lands. A hundredth of a
 * percent is about 17 hours at 5% a year. `repayBuild` says why this isn't the max-uint form.
 */
const REPAY_MARGIN_DIVISOR = BigInt(10_000)

const POOL_ABI = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)',
])

const POOL_READS_ABI = parseAbi([
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getUserEMode(address user) view returns (uint256)',
])

const DATA_PROVIDER_ABI = parseAbi([
  'function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
  'function getReserveData(address asset) view returns (uint256 unbacked, uint256 accruedToTreasuryScaled, uint256 totalAToken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp)',
  'function getPaused(address asset) view returns (bool)',
  'function getReserveCaps(address asset) view returns (uint256 borrowCap, uint256 supplyCap)',
  'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
])

const PROVIDER_ABI = parseAbi(['function getPriceOracle() view returns (address)'])
const ORACLE_ABI = parseAbi(['function getAssetPrice(address asset) view returns (uint256)'])
const BALANCE_ABI = parseAbi(['function balanceOf(address account) view returns (uint256)'])

/** A market takes what it lists, which the chain's table of everything Intent knows doesn't say. */
function named(tokens: readonly ChainToken[], symbols: readonly string[]): ChainToken[] {
  return tokens.filter((token) => symbols.includes(token.symbol))
}

const AAVE_ADMIN_NOTE =
  'Aave governance can upgrade its contracts and change its settings, and a guardian can freeze or pause a market without a vote. It froze its V3 markets, Avalanche and Monad among them, on 29 October 2026 after a Binance hot wallet exploit, and this app checks the current state each time.'

const KELP_NOTE =
  'The KelpDAO rsETH exploit of 18 April 2026, about $292M, left Aave with bad debt estimated at $123.7M to $230.1M, mostly on Ethereum, Arbitrum and Mantle. Aave reported most of the rsETH recovered by May 2026. I could not confirm the recovery is finished.'

const AAVE_ORACLE_NOTE =
  'A price oracle misconfiguration on Aave V3 on Ethereum cost about $862,000 on 12 March 2026.'

export interface AaveMarket {
  id: string
  name: string
  chain: EvmChain
  pool: string
  addressesProvider: string
  dataProvider: string
  tokens: ChainToken[]
  /** What the person reads about who controls this market and what has gone wrong with it. */
  riskNotes: string[]
}

/** Pool, provider and data provider: bgd-labs/aave-address-book, src/AaveV3Avalanche.sol. */
export const AAVE_AVALANCHE_MARKET: AaveMarket = {
  id: 'aave-avalanche',
  name: 'Aave',
  chain: 'avalanche',
  pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  addressesProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
  dataProvider: '0x243Aa95cAC2a25651eda86e80bEe66114413c43b',
  tokens: named(AVALANCHE_TOKENS, ['USDC', 'USDT', 'WAVAX', 'WETH.e']),
  riskNotes: [
    AAVE_ADMIN_NOTE,
    KELP_NOTE,
    'This Avalanche market listed wrsETH, now frozen. Read from the chain on 5 November 2026, it carried bad debt not yet covered of about 202,000 USDT out of 24.9M supplied, and about 7,600 USDC out of 67.8M.',
    AAVE_ORACLE_NOTE,
  ],
}

/** Pool, provider and data provider: bgd-labs/aave-address-book, src/AaveV3Monad.sol. */
export const AAVE_MONAD_MARKET: AaveMarket = {
  id: 'aave-monad',
  name: 'Aave',
  chain: 'monad',
  pool: '0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef',
  addressesProvider: '0x34793Fb9935F7bB5E5aE920fb963F39063E7A615',
  dataProvider: '0xB65A68B98274ef7D9a60E0C0747dD1BEc3D32fad',
  tokens: named(MONAD_TOKENS, ['USDC', 'USDT0', 'WETH']),
  riskNotes: [
    AAVE_ADMIN_NOTE,
    `${KELP_NOTE} This Monad market does not list rsETH.`,
    AAVE_ORACLE_NOTE,
  ],
}

/** The main market only. https://docs.neverland.money/smart-contracts.md, "Core Lending". */
export const NEVERLAND_MARKET: AaveMarket = {
  id: 'neverland',
  name: 'Neverland',
  chain: 'monad',
  pool: '0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585',
  addressesProvider: '0x49D75170F55C964dfdd6726c74fdEDEe75553A0f',
  dataProvider: '0xfd0b6b6F736376F7B99ee989c749007c7757fDba',
  tokens: named(MONAD_TOKENS, ['USDC', 'USDT0']),
  riskNotes: [
    'Neverland is a separate app built from Aave V3’s code, and is not run by Aave. It holds far less, about $5.3M on DefiLlama in November 2026, so one large withdrawal can leave little free for a while.',
    'Neverland’s team controls it through a multisig. Upgrades and governance changes wait out a 24-hour timelock and risk settings a 1-hour one, and a separate multisig can pause it with no delay. DefiLlama lists no incident for it.',
  ],
}

function refuse(reason: string): never {
  throw new ChainActionRefused(`${reason} Nothing was signed or sent.`)
}

function checkPoolCall(market: AaveMarket, call: DecodedCall, context: CheckContext): void {
  const { functionName, args } = call
  const { account, approval } = context
  const [asset, amount] = args as readonly [string, bigint]
  const token = market.tokens.find((t) => sameAddress(t.id, asset))
  if (token === undefined) {
    refuse(`This uses a token I haven't confirmed for ${market.name}.`)
  }
  // Max-uint on a withdraw is the Pool's own "all of mine", and it pays only `to`, checked below.
  if (amount === BigInt(0) || (amount === maxUint256 && functionName !== 'withdraw')) {
    refuse('This transaction’s amount is not one the person asked for.')
  }

  let forWhom: string
  let pulls = false
  if (functionName === 'supply') {
    const [, , onBehalfOf, referralCode] = args as readonly [string, bigint, string, number]
    if (referralCode !== 0) refuse('This transaction carries a referral code.')
    forWhom = onBehalfOf
    pulls = true
  } else if (functionName === 'withdraw') {
    forWhom = (args as readonly [string, bigint, string])[2]
  } else if (functionName === 'borrow') {
    const [, , rateMode, referralCode, onBehalfOf] = args as readonly [
      string,
      bigint,
      bigint,
      number,
      string,
    ]
    if (rateMode !== VARIABLE_RATE) refuse('Only a variable-rate loan is allowed.')
    if (referralCode !== 0) refuse('This transaction carries a referral code.')
    forWhom = onBehalfOf
  } else if (functionName === 'repay') {
    const [, , rateMode, onBehalfOf] = args as readonly [string, bigint, bigint, string]
    if (rateMode !== VARIABLE_RATE) refuse('Only a variable-rate loan is allowed.')
    forWhom = onBehalfOf
    pulls = true
  } else {
    refuse(`This transaction does something I haven't confirmed for ${market.name}.`)
  }

  if (!sameAddress(forWhom, account)) {
    refuse('This transaction credits, pays or borrows for someone other than you.')
  }
  if (approval === undefined) return
  if (!pulls) refuse('This action takes no approval.')
  if (!sameAddress(approval.token, asset) || approval.units !== amount) {
    refuse('This approval doesn’t match the amount and token of the action.')
  }
}

export function aavePolicy(market: AaveMarket): EvmCallPolicy {
  return {
    venueName: market.name,
    chain: market.chain,
    contracts: {
      [market.pool]: {
        abi: POOL_ABI,
        functions: ['supply', 'withdraw', 'borrow', 'repay'],
        check: (call, context) => checkPoolCall(market, call, context),
      },
    },
    spenders: [market.pool],
    approvable: market.tokens.map((token) => token.id),
  }
}

export async function readReserve(market: AaveMarket, token: ChainToken, reader: EvmReaderClient) {
  const contract = { address: market.dataProvider as Address, abi: DATA_PROVIDER_ABI }
  const args = [token.id as Address] as const
  const [config, data, paused, caps] = await Promise.all([
    reader.readContract({ ...contract, functionName: 'getReserveConfigurationData', args }),
    reader.readContract({ ...contract, functionName: 'getReserveData', args }),
    reader.readContract({ ...contract, functionName: 'getPaused', args }),
    reader.readContract({ ...contract, functionName: 'getReserveCaps', args }),
  ])
  const [, ltv, threshold, , , , borrowingEnabled, , active, frozen] = config
  const [, , totalAToken, totalStableDebt, totalVariableDebt, liquidityRate, variableBorrowRate] =
    data
  const totalDebt = totalStableDebt + totalVariableDebt
  return {
    ltv,
    threshold,
    borrowingEnabled,
    active,
    frozen,
    paused,
    totalAToken,
    totalDebt,
    free: totalAToken > totalDebt ? totalAToken - totalDebt : BigInt(0),
    liquidityRate,
    variableBorrowRate,
    borrowCap: caps[0],
    supplyCap: caps[1],
  }
}

type Reserve = Awaited<ReturnType<typeof readReserve>>

/** The rate as a year's compounded percent, kept to two places. The chain states a yearly ray rate. */
function ratePercent(rayRate: bigint): number {
  const perSecond = Number(rayRate) / RAY / SECONDS_PER_YEAR
  return Number(((Math.pow(1 + perSecond, SECONDS_PER_YEAR) - 1) * 100).toFixed(2))
}

function display(units: bigint, token: ChainToken): string {
  return formatUnits(units, token.decimals)
}

function healthText(bps: bigint): string {
  return (Number(bps) / 10_000).toFixed(2)
}

function assertTakesAny(market: AaveMarket, token: ChainToken, reserve: Reserve): void {
  const { name, chain } = market
  const where = `${name} on ${EVM_CHAINS[chain].name}`
  if (!reserve.active) refuse(`${where} isn't open for ${token.symbol} right now.`)
  if (reserve.paused) {
    refuse(
      `${where} has paused ${token.symbol} right now. Nothing can go in or come out until it reopens, and what you hold there stays yours.`
    )
  }
}

function assertOpenForNew(market: AaveMarket, token: ChainToken, reserve: Reserve): void {
  assertTakesAny(market, token, reserve)
  if (reserve.frozen) {
    refuse(
      `${market.name} has frozen ${token.symbol} on ${EVM_CHAINS[market.chain].name} right now, so nothing new can start. Repaying and withdrawing stay open.`
    )
  }
}

function assertSupplyOpen(
  market: AaveMarket,
  token: ChainToken,
  reserve: Reserve,
  amount: bigint
): void {
  assertOpenForNew(market, token, reserve)
  const unit = BigInt(10) ** BigInt(token.decimals)
  if (reserve.supplyCap !== BigInt(0) && reserve.totalAToken + amount > reserve.supplyCap * unit) {
    refuse(`${market.name}'s supply cap for ${token.symbol} leaves no room for this right now.`)
  }
}

function accountUnits(request: ChainActionRequest, account: string, market: AaveMarket) {
  if (!isAddress(account, { strict: false }) || sameAddress(account, zeroAddress)) {
    refuse('That is not a wallet address on this chain.')
  }
  const token = tokenBySymbol(market.tokens, request.tokenIn)
  if (token === undefined) {
    const symbols = market.tokens.map((t) => t.symbol).join(', ')
    refuse(`${market.name} takes ${symbols} here, not ${request.tokenIn}.`)
  }
  return { token, amount: BigInt(toBaseUnits(request.amount, token.decimals)) }
}

function poolCalldata(
  kind: 'supply' | 'withdraw' | 'borrow' | 'repay',
  asset: Address,
  amount: bigint,
  account: Address
): Hex {
  const abi = POOL_ABI
  switch (kind) {
    case 'supply':
      return encodeFunctionData({
        abi,
        functionName: 'supply',
        args: [asset, amount, account, 0],
      })
    case 'withdraw':
      return encodeFunctionData({ abi, functionName: 'withdraw', args: [asset, amount, account] })
    case 'borrow':
      return encodeFunctionData({
        abi,
        functionName: 'borrow',
        args: [asset, amount, VARIABLE_RATE, 0, account],
      })
    case 'repay':
      return encodeFunctionData({
        abi,
        functionName: 'repay',
        args: [asset, amount, VARIABLE_RATE, account],
      })
  }
}

async function readAccount(market: AaveMarket, account: Address, reader: EvmReaderClient) {
  const [collateral, debt, available, threshold] = await reader.readContract({
    address: market.pool as Address,
    abi: POOL_READS_ABI,
    functionName: 'getUserAccountData',
    args: [account],
  })
  return { collateral, debt, available, threshold }
}

/** From the oracle the Pool itself prices with, so a check here matches the one it will run. */
async function oraclePrice(
  market: AaveMarket,
  token: ChainToken,
  reader: EvmReaderClient
): Promise<bigint> {
  const oracle = await reader.readContract({
    address: market.addressesProvider as Address,
    abi: PROVIDER_ABI,
    functionName: 'getPriceOracle',
  })
  return reader.readContract({
    address: oracle,
    abi: ORACLE_ABI,
    functionName: 'getAssetPrice',
    args: [token.id as Address],
  })
}

/** The base-currency value of an amount, rounded up so a risk check never reads it as less. */
async function valueOf(
  market: AaveMarket,
  token: ChainToken,
  amount: bigint,
  reader: EvmReaderClient
): Promise<bigint> {
  const price = await oraclePrice(market, token, reader)
  if (price === BigInt(0)) {
    refuse(`${market.name} has no price for ${token.symbol} right now, so I can't check this.`)
  }
  const unit = BigInt(10) ** BigInt(token.decimals)
  return (amount * price + unit - BigInt(1)) / unit
}

async function borrowNotes(
  market: AaveMarket,
  token: ChainToken,
  reserve: Reserve,
  amount: bigint,
  account: Address,
  reader: EvmReaderClient
): Promise<string[]> {
  assertOpenForNew(market, token, reserve)
  if (!reserve.borrowingEnabled) {
    refuse(`${market.name} doesn't lend ${token.symbol} here right now, so you can't borrow it.`)
  }
  const unit = BigInt(10) ** BigInt(token.decimals)
  if (reserve.borrowCap !== BigInt(0) && reserve.totalDebt + amount > reserve.borrowCap * unit) {
    refuse(`${market.name}'s borrow cap for ${token.symbol} leaves no room for this right now.`)
  }
  if (amount > reserve.free) {
    refuse(
      `Only about ${display(reserve.free, token)} ${token.symbol} is free to borrow on ${market.name} right now.`
    )
  }
  const position = await readAccount(market, account, reader)
  if (position.collateral === BigInt(0)) {
    refuse(`You have no collateral on ${market.name} here, so there is nothing to borrow against.`)
  }
  const value = await valueOf(market, token, amount, reader)
  if (value > position.available) {
    refuse(
      `Your collateral on ${market.name} can't back this loan right now. Not every token counts toward a new loan.`
    )
  }
  const health = (position.collateral * position.threshold) / (position.debt + value)
  if (health < MIN_HEALTH_BPS) {
    refuse(
      `This borrow would leave your health factor at ${healthText(health)}. This app stops at ${MIN_HEALTH_FACTOR}, to keep room before liquidation. Borrow less or add collateral.`
    )
  }
  return [
    `A borrow can be liquidated. If your collateral falls in value or this debt grows, and your health factor drops under 1.00, anyone can sell your collateral to pay the debt, and you lose a penalty on top. This loan leaves your health factor at ${healthText(health)}. This app refuses a borrow under ${MIN_HEALTH_FACTOR}, but it does not watch the loan afterwards.`,
    `The rate is variable, about ${ratePercent(reserve.variableBorrowRate)}% a year now, and it can rise quickly. To close the loan, ask to repay ${token.symbol} on ${market.name}.`,
  ]
}

/** What the card says, what the call names, and the figure shown. */
interface ExitBuild {
  notes: string[]
  callAmount: bigint
  shown: string
}

async function withdrawBuild(
  market: AaveMarket,
  token: ChainToken,
  reserve: Reserve,
  request: ChainActionRequest,
  amount: bigint,
  account: Address,
  reader: EvmReaderClient
): Promise<ExitBuild> {
  assertTakesAny(market, token, reserve)
  const [supplied, , , , , , , , usedAsCollateral] = await reader.readContract({
    address: market.dataProvider as Address,
    abi: DATA_PROVIDER_ABI,
    functionName: 'getUserReserveData',
    args: [token.id as Address, account],
  })
  const whole = request.wholePosition === true
  if (whole && supplied === BigInt(0)) {
    refuse(`You have no ${token.symbol} supplied to ${market.name} here.`)
  }
  if (!whole && amount > supplied) {
    refuse(
      `You have ${display(supplied, token)} ${token.symbol} supplied to ${market.name} here, which is less than this.`
    )
  }
  const taken = whole ? supplied : amount
  if (taken > reserve.free) {
    refuse(
      `Only about ${display(reserve.free, token)} ${token.symbol} is free on ${market.name} right now, since the rest is lent out. You can take that much now, and more frees up as borrowers repay.`
    )
  }
  const position = await readAccount(market, account, reader)
  const notes = [
    whole
      ? `This takes all of your ${token.symbol} here, with the interest earned up to the moment it lands, so nothing stays behind.`
      : `You have about ${display(supplied, token)} ${token.symbol} supplied here. Interest keeps adding to it, so a small remainder can stay after this.`,
  ]
  const call = {
    callAmount: whole ? maxUint256 : amount,
    shown: whole ? display(supplied, token) : request.amount,
  }
  if (position.debt === BigInt(0) || !usedAsCollateral) return { notes, ...call }

  const eMode = await reader.readContract({
    address: market.pool as Address,
    abi: POOL_READS_ABI,
    functionName: 'getUserEMode',
    args: [account],
  })
  if (eMode !== BigInt(0)) {
    refuse(
      `Your account is in E-Mode with a loan open, and I can't check what this withdraw would do to it. Repay the loan first.`
    )
  }
  const value = await valueOf(market, token, taken, reader)
  const held = position.collateral * position.threshold
  const removed = value * reserve.threshold
  const health = held > removed ? (held - removed) / position.debt : BigInt(0)
  if (health < MIN_HEALTH_BPS) {
    refuse(
      `This ${token.symbol} backs your loan on ${market.name}, and taking it out would leave your health factor at ${healthText(health)}. This app stops at ${MIN_HEALTH_FACTOR}, to keep room before liquidation. Repay some of the loan first, or withdraw less.`
    )
  }
  return {
    notes: [
      ...notes,
      `This supply backs your loan, so taking it out leaves your health factor at ${healthText(health)}.`,
    ],
    ...call,
  }
}

async function assertHolds(
  token: ChainToken,
  needed: bigint,
  account: Address,
  reader: EvmReaderClient
): Promise<void> {
  const held = await reader.readContract({
    address: token.id as Address,
    abi: BALANCE_ABI,
    functionName: 'balanceOf',
    args: [account],
  })
  if (held < needed) {
    refuse(
      `You hold ${display(held, token)} ${token.symbol}, which is less than the ${display(needed, token)} this needs.`
    )
  }
}

/**
 * A whole repay names a number just over the debt, not max-uint. The Pool takes the lesser of what
 * is named and what is owed, so nothing past the debt moves, and the approval still equals the
 * amount, so `checkPoolCall` allows nothing new. Max-uint would need an allowance covering the debt
 * as it stands when this lands, and `call.ts` rightly refuses an unlimited one, so interest passing
 * an exact approval would revert it. Interest passing this number only leaves a remainder.
 */
async function repayBuild(
  market: AaveMarket,
  token: ChainToken,
  reserve: Reserve,
  request: ChainActionRequest,
  amount: bigint,
  account: Address,
  reader: EvmReaderClient
): Promise<ExitBuild> {
  assertTakesAny(market, token, reserve)
  const [, , owed] = await reader.readContract({
    address: market.dataProvider as Address,
    abi: DATA_PROVIDER_ABI,
    functionName: 'getUserReserveData',
    args: [token.id as Address, account],
  })
  if (owed === BigInt(0)) {
    refuse(`You don't owe any ${token.symbol} on ${market.name} here.`)
  }
  if (request.wholePosition === true) {
    const callAmount = owed + owed / REPAY_MARGIN_DIVISOR + BigInt(1)
    await assertHolds(token, owed, account, reader)
    return {
      callAmount,
      shown: display(owed, token),
      notes: [
        `This pays off your whole ${token.symbol} loan, about ${display(owed, token)}. Interest keeps adding until it lands, so this allows up to ${display(callAmount, token)}. Only what you owe is taken, and the rest stays in your wallet. An approval for the rest stays until it is used or replaced.`,
        `Your wallet needs a little more than the loan, since it grows until this lands. If it grew past ${display(callAmount, token)} first, that much is paid and a small remainder stays owing.`,
      ],
    }
  }
  await assertHolds(token, amount < owed ? amount : owed, account, reader)
  const owes = `You owe about ${display(owed, token)} ${token.symbol}. Interest keeps adding, so paying that exact amount can leave a small remainder.`
  return {
    callAmount: amount,
    shown: request.amount,
    notes:
      amount > owed
        ? [
            owes,
            'Only what you owe is taken, and the rest stays in your wallet. An approval for the rest stays until it is used or replaced.',
          ]
        : [owes],
  }
}

/** Aave V3's errors, then the numbered strings of the older code Neverland runs. */
const REVERT_REASONS: Record<string, 'zero-ltv' | 'health' | 'paused'> = {
  [toFunctionSelector('LtvValidationFailed()')]: 'zero-ltv',
  [toFunctionSelector('HealthFactorLowerThanLiquidationThreshold()')]: 'health',
  [toFunctionSelector('ReservePaused()')]: 'paused',
  '57': 'zero-ltv',
  '35': 'health',
  '29': 'paused',
}
const ERROR_STRING = '0x08c379a0'

function revertData(error: unknown): string | undefined {
  let current: unknown = error
  while (typeof current === 'object' && current !== null) {
    const { data, cause } = current as { data?: unknown; cause?: unknown }
    if (typeof data === 'string') return data
    current = cause
  }
  return undefined
}

function revertReason(data: string | undefined) {
  if (data === undefined) return undefined
  if (!data.startsWith(ERROR_STRING)) return REVERT_REASONS[data.slice(0, 10)]
  try {
    const [code] = decodeAbiParameters([{ type: 'string' }], `0x${data.slice(10)}`)
    return REVERT_REASONS[code]
  } catch {
    return undefined
  }
}

/**
 * Words for an exit the Pool turned down, asked again only once it has. The chain's reason is the
 * one thing that names a hold from another token: USDC and USDT count for nothing toward a loan on
 * Aave's Avalanche market, and such collateral has to come out before any other can.
 */
async function refuseFailedExit(
  market: AaveMarket,
  token: ChainToken,
  data: Hex,
  account: Address,
  reader: EvmReaderClient
): Promise<never> {
  let reason: ReturnType<typeof revertReason>
  try {
    await reader.call({ account, to: market.pool as Address, data })
  } catch (error) {
    reason = revertReason(revertData(error))
  }
  if (reason === 'zero-ltv') {
    refuse(
      `You have a loan on ${market.name}, and part of your collateral is in a token it doesn't count toward loans right now. ${market.name} makes you withdraw that token first, or repay the loan, before ${token.symbol} can come out.`
    )
  }
  if (reason === 'health') {
    refuse(
      `${market.name} won't release this, because your loan needs it as collateral. Repay some of the loan first, or withdraw less.`
    )
  }
  if (reason === 'paused') {
    refuse(`${market.name} has paused ${token.symbol} right now, so this can't go through yet.`)
  }
  return refuse(
    `This would fail on the chain right now, and ${market.name} didn't say why in a way I can read. What you hold there hasn't changed. Check you have enough for the network fee, or try a smaller amount.`
  )
}

function supplyNotes(market: AaveMarket, token: ChainToken, reserve: Reserve): string[] {
  return [
    `This rate is variable, and is the base rate only: any rewards are not counted. To get out, ask to withdraw ${token.symbol} on ${market.name}. You can while the pool has money free, and if most is lent out you wait for borrowers to repay.`,
    ...(reserve.ltv === BigInt(0)
      ? [`${token.symbol} can't back a new loan on ${market.name} here right now.`]
      : []),
  ]
}

const SUMMARY: Record<
  'supply' | 'withdraw' | 'borrow' | 'repay',
  (amount: string, symbol: string, where: string) => string
> = {
  supply: (amount, symbol, where) => `Supply ${amount} ${symbol} to ${where}.`,
  withdraw: (amount, symbol, where) => `Withdraw ${amount} ${symbol} from ${where}.`,
  borrow: (amount, symbol, where) => `Borrow ${amount} ${symbol} from ${where} at a variable rate.`,
  repay: (amount, symbol, where) => `Repay ${amount} ${symbol} of your loan on ${where}.`,
}

const WHOLE_SUMMARY: Record<'withdraw' | 'repay', (typeof SUMMARY)['repay']> = {
  withdraw: (amount, symbol, where) =>
    `Withdraw all of your ${symbol}, about ${amount}, from ${where}.`,
  repay: (amount, symbol, where) =>
    `Repay all of your ${symbol} loan, about ${amount}, on ${where}.`,
}

/** A market's token price in dollars, from the oracle its Pool uses. Any doubt is no price. */
export async function aaveOraclePriceUsd(
  market: AaveMarket,
  token: ChainToken,
  reader: EvmReaderClient = evmReader(market.chain)
): Promise<number | undefined> {
  try {
    const price = await oraclePrice(market, token, reader)
    return price === BigInt(0) ? undefined : Number(price) / ORACLE_UNIT
  } catch {
    return undefined
  }
}

export function createAaveVenue(
  market: AaveMarket,
  givenReader?: EvmReaderClient,
  client?: EvmClient
): ChainVenue {
  const policy = aavePolicy(market)
  const readerNow = () => givenReader ?? evmReader(market.chain)
  const chainName = EVM_CHAINS[market.chain].name

  /** Any read that fails stops here, since none of these checks may be skipped. */
  async function failingClosed<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (e) {
      if (e instanceof ChainActionRefused) throw e
      return refuse(
        `I couldn't read ${market.name} on ${chainName} just now, so this wasn't built.`
      )
    }
  }

  async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
    const { token, amount } = accountUnits(request, account, market)
    return failingClosed(async () => {
      const reserve = await readReserve(market, token, readerNow())
      assertSupplyOpen(market, token, reserve, amount)
      return quotedApy({ basePercent: ratePercent(reserve.liquidityRate) })
    })
  }

  async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
    const { kind } = request
    if (kind !== 'supply' && kind !== 'withdraw' && kind !== 'borrow' && kind !== 'repay') {
      refuse(`${market.name} can't ${kind} here.`)
    }
    const { token, amount } = accountUnits(request, account, market)
    const person = account as Address
    return failingClosed(async () => {
      const reader = readerNow()
      const reserve = await readReserve(market, token, reader)

      let notes: string[]
      let callAmount = amount
      let shown = request.amount
      if (kind === 'supply') {
        assertSupplyOpen(market, token, reserve, amount)
        await assertHolds(token, amount, person, reader)
        notes = supplyNotes(market, token, reserve)
      } else if (kind === 'borrow') {
        notes = await borrowNotes(market, token, reserve, amount, person, reader)
      } else {
        const build = kind === 'withdraw' ? withdrawBuild : repayBuild
        ;({ notes, callAmount, shown } = await build(
          market,
          token,
          reserve,
          request,
          amount,
          person,
          reader
        ))
      }

      const pullsToken = kind === 'supply' || kind === 'repay'
      const data = poolCalldata(kind, token.id as Address, callAmount, person)
      const { signing, needsApproval } = await buildEvmCall(
        {
          chain: market.chain,
          account,
          to: market.pool,
          data,
          ...(pullsToken
            ? { pull: { token: token.id, spender: market.pool, units: callAmount } }
            : {}),
        },
        reader
      ).catch((error: unknown) => {
        if (error instanceof ChainActionRefused && (kind === 'withdraw' || kind === 'repay')) {
          return refuseFailedExit(market, token, data, person, reader)
        }
        throw error
      })
      const whole = request.wholePosition === true && (kind === 'withdraw' || kind === 'repay')
      const summary = whole ? WHOLE_SUMMARY[kind] : SUMMARY[kind]
      return {
        venueId: market.id,
        venueName: market.name,
        kind,
        summary: summary(shown, token.symbol, `${market.name} on ${chainName}`),
        pay: { amount: shown, symbol: token.symbol },
        ...(kind === 'supply' ? { apy: { basePercent: ratePercent(reserve.liquidityRate) } } : {}),
        notes: [
          ...notes,
          ...(needsApproval
            ? [approvalNote(market.name, display(callAmount, token), token.symbol)]
            : []),
          ...market.riskNotes,
        ],
        signing,
      }
    })
  }

  /** One multicall, so every figure is from the same block. A failed read throws. */
  async function positions(account: string): Promise<VenuePosition[]> {
    if (!isAddress(account, { strict: false }) || sameAddress(account, zeroAddress)) {
      refuse('That is not a wallet address on this chain.')
    }
    const rows = await readerNow().multicall({
      allowFailure: false,
      contracts: market.tokens.map((token) => ({
        address: market.dataProvider as Address,
        abi: DATA_PROVIDER_ABI,
        functionName: 'getUserReserveData' as const,
        args: [token.id as Address, account as Address] as const,
      })),
    })
    return market.tokens.flatMap((token, index): VenuePosition[] => {
      const [supplied, , owed] = rows[index] as readonly bigint[] as [bigint, bigint, bigint]
      return [
        ...(supplied > BigInt(0)
          ? [{ slot: 'supplied' as const, symbol: token.symbol, amount: display(supplied, token) }]
          : []),
        ...(owed > BigInt(0)
          ? [{ slot: 'borrowed' as const, symbol: token.symbol, amount: display(owed, token) }]
          : []),
      ]
    })
  }

  const takesListed = takesOnly(
    market.name,
    market.tokens.map((token) => token.symbol)
  )

  /**
   * Asked before a swap is signed, so a reserve that is full, frozen or paused says so then, and not
   * once the swap has left the person holding a token they did not want. The size isn't known yet, so
   * this asks for room for one whole token, and the build checks the real amount.
   */
  async function assertCanFollow(step: FollowOnStep, account: string): Promise<void> {
    await takesListed(step, account)
    const token = tokenBySymbol(market.tokens, step.tokenIn)
    if (step.kind !== 'supply' || token === undefined) return
    await failingClosed(async () => {
      const reserve = await readReserve(market, token, readerNow())
      assertSupplyOpen(market, token, reserve, BigInt(10) ** BigInt(token.decimals))
    })
  }

  return {
    id: market.id,
    name: market.name,
    kinds: ['supply', 'withdraw', 'borrow', 'repay'],
    assertCanFollow,
    quote,
    prepare,
    positions,
    ...evmCallVenueParts(policy, client),
  }
}

export const aaveAvalancheVenue = createAaveVenue(AAVE_AVALANCHE_MARKET)
export const aaveMonadVenue = createAaveVenue(AAVE_MONAD_MARKET)
export const neverlandVenue = createAaveVenue(NEVERLAND_MARKET)
