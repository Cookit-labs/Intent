import {
  ChainActionRefused,
  takesOnly,
  toBaseUnits,
  tokenBySymbol,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type FollowOnStep,
  type NearTransaction,
  type PreparedAction,
  type SubmitInput,
  type SubmitResult,
  type VenuePosition,
  type VenueQuote,
} from '../types'
import { NEAR_ACCOUNT, NEAR_TX_HASH } from './account'
import {
  amountKept,
  followTransaction,
  readPythInfos,
  readTokenPrice,
  type TokenPrice,
} from './rhea-read'
import {
  assertRheaLendSafe,
  RHEA_EXECUTE_GAS,
  RHEA_EXECUTE_PYTH_GAS,
  RHEA_EXTRA_DECIMALS,
  RHEA_LEND,
  RHEA_LEND_STORAGE_YOCTO,
  RHEA_LEND_TOKEN_GAS,
  RHEA_PRICE_ORACLE,
} from './rhea-safety'
import { isRegistered, viewCall } from './rpc'
import { STORAGE_DEPOSIT_YOCTO, STORAGE_GAS, WRAP_GAS } from './safety'
import { explorerUrl, formatUnits, nearTokens, WRAP_NEAR } from './tokens'

/** What this app lends through here, whatever else the chain's table comes to hold. */
const LEND_TOKENS = nearTokens.filter((token) => ['NEAR', 'USDC', 'USDT'].includes(token.symbol))

export const RHEA_LEND_VENUE_ID = 'rhea-lend'
const VENUE = 'Rhea Lend'
const REGULAR = 'REGULAR'

/**
 * The contract refuses only at 100%, where a position can already be liquidated. A borrow or
 * withdrawal this app builds keeps collateral at 120% of what the contract counts as owed.
 */
const SAFE_HEALTH_BPS = BigInt(12_000)
/** An exit reads positions inside 6 seconds, and the warning must not be what makes it miss them. */
const LOAN_WARNING_READ_MS = 2_500
const BPS = BigInt(10_000)
const USD_SCALE = BigInt(10) ** BigInt(18)
/** Interest runs while a repayment waits for a signature, so paying off sends a little over. */
const REPAY_MARGIN_DIVISOR = BigInt(1000)
/** Rhea's front end unwraps 10 yocto less than it takes out, for the contract's rounding. */
const UNWRAP_ROUNDING = BigInt(10)
const CONFIRM_WAIT_MS = 25_000

const RISK_NOTE =
  "Rhea lost about $18.4M in April 2026 through its margin trading feature, since shut down. Reports differ on what was recovered, and this app couldn't confirm a finished compensation plan. A DAO, burrow.sputnik-dao.near, can change this contract."

const STORAGE_NOTE =
  'Your first use of Rhea Lend also pays 0.1 NEAR for your record there. It stays with Rhea Lend while you use it, and this app has no step to take it back yet.'

interface AssetView {
  token_id: string
  supplied: { balance: string }
  borrowed: { balance: string }
  margin_debt: { balance: string }
  margin_pending_debt: string
  reserved: string
  prot_fee: string
  supply_apr: string
  borrow_apr: string
  config: {
    extra_decimals: number
    volatility_ratio: number
    can_deposit: boolean
    can_withdraw: boolean
    can_use_as_collateral: boolean
    can_borrow: boolean
    supplied_limit: string | null
    borrowed_limit: string | null
    min_borrowed_amount: string | null
  }
}

interface Line {
  token_id: string
  balance: string
}

interface AccountView {
  supplied: Line[]
  positions: Record<string, { collateral: Line[]; borrowed: Line[] }>
  is_locked: boolean
}

interface ContractConfig {
  contract_mode: string
  enable_pyth_oracle: boolean
  pyth_oracle_account_id: string
}

/** What an account holds, in the contract's own 18 or 24 decimal units, interest included. */
interface Holdings {
  registered: boolean
  locked: boolean
  plain: Map<string, bigint>
  collateral: Map<string, bigint>
  borrowed: Map<string, bigint>
}

function cannotRead(): ChainActionRefused {
  return new ChainActionRefused(
    'Rhea Lend could not be read from NEAR just now, so nothing was built. Try again in a minute. Nothing was signed or sent.'
  )
}

function noPrices(): ChainActionRefused {
  return new ChainActionRefused(
    "Rhea Lend's prices couldn't be read just now, and it checks every loan against them. Try again in a minute. Nothing was signed or sent."
  )
}

function assertAccount(account: string): void {
  if (!NEAR_ACCOUNT.test(account)) {
    throw new ChainActionRefused('That is not a NEAR account. Connect a NEAR wallet and try again.')
  }
}

function linesToMap(lines: readonly Line[]): Map<string, bigint> {
  return new Map(lines.map((line) => [line.token_id, BigInt(line.balance)]))
}

async function readHoldings(account: string): Promise<Holdings> {
  const view = await viewCall<AccountView | null>(RHEA_LEND, 'get_account_all_positions', {
    account_id: account,
  })
  if (view === null) {
    return {
      registered: false,
      locked: false,
      plain: new Map(),
      collateral: new Map(),
      borrowed: new Map(),
    }
  }
  const regular = view.positions[REGULAR]
  return {
    registered: true,
    locked: view.is_locked,
    plain: linesToMap(view.supplied),
    collateral: linesToMap(regular?.collateral ?? []),
    borrowed: linesToMap(regular?.borrowed ?? []),
  }
}

function held(map: ReadonlyMap<string, bigint>, token: string): bigint {
  return map.get(token) ?? BigInt(0)
}

function innerScale(token: ChainToken): bigint {
  return BigInt(10) ** BigInt(RHEA_EXTRA_DECIMALS[token.id] as number)
}

function displayOf(inner: bigint, token: ChainToken): string {
  return formatUnits((inner / innerScale(token)).toString(), token.decimals)
}

/** Every token here is checked against the pinned scale, since it decides what gets signed. */
async function readAsset(token: ChainToken): Promise<AssetView> {
  const asset = await viewCall<AssetView>(RHEA_LEND, 'get_asset', { token_id: token.id })
  if (asset.config.extra_decimals !== RHEA_EXTRA_DECIMALS[token.id]) {
    throw new Error('asset scale changed')
  }
  return asset
}

function availableOf(asset: AssetView): bigint {
  return (
    BigInt(asset.supplied.balance) +
    BigInt(asset.reserved) +
    BigInt(asset.prot_fee) -
    BigInt(asset.borrowed.balance) -
    BigInt(asset.margin_debt.balance) -
    BigInt(asset.margin_pending_debt)
  )
}

function percentOf(rate: string): number {
  return Number(rate) * 100
}

function usedPercent(asset: AssetView): string {
  const supplied = Number(asset.supplied.balance)
  return supplied > 0 ? ((Number(asset.borrowed.balance) / supplied) * 100).toFixed(0) : '0'
}

async function assertOpen(needsPrices: boolean): Promise<void> {
  let config: ContractConfig
  try {
    config = await viewCall<ContractConfig>(RHEA_LEND, 'get_config')
  } catch {
    throw cannotRead()
  }
  if (config.contract_mode !== 'Running') {
    throw new ChainActionRefused('Rhea Lend is paused right now. Nothing was signed or sent.')
  }
  if (
    needsPrices &&
    (!config.enable_pyth_oracle || config.pyth_oracle_account_id !== RHEA_PRICE_ORACLE)
  ) {
    throw new ChainActionRefused(
      "Rhea Lend isn't taking prices from the source this app checks, so this was not built. Nothing was signed or sent."
    )
  }
}

function requireToken(request: ChainActionRequest): ChainToken {
  const token = tokenBySymbol(LEND_TOKENS, request.tokenIn)
  if (token === undefined) throw new ChainActionRefused(`${VENUE} here takes NEAR, USDC or USDT.`)
  return token
}

function functionCall(
  methodName: string,
  args: Record<string, unknown>,
  gas: bigint,
  deposit: string
): NearTransaction['actions'][number] {
  return { type: 'FunctionCall', params: { methodName, args, gas: gas.toString(), deposit } }
}

function tokenStorage(account: string): NearTransaction['actions'][number] {
  return functionCall(
    'storage_deposit',
    { account_id: account, registration_only: true },
    STORAGE_GAS,
    STORAGE_DEPOSIT_YOCTO
  )
}

function lendStorage(account: string): NearTransaction {
  return {
    receiverId: RHEA_LEND,
    actions: [
      functionCall(
        'storage_deposit',
        { account_id: account, registration_only: true },
        STORAGE_GAS,
        RHEA_LEND_STORAGE_YOCTO
      ),
    ],
  }
}

/** Spending a token into Rhea Lend. NEAR is wrapped in the same transaction, so both or neither. */
function depositTransaction(
  token: ChainToken,
  amount: string,
  msg: string,
  account: string,
  registeredOnWrap: boolean
): NearTransaction {
  const actions: NearTransaction['actions'] = []
  if (token.id === WRAP_NEAR) {
    if (!registeredOnWrap) actions.push(tokenStorage(account))
    actions.push(functionCall('near_deposit', {}, WRAP_GAS, amount))
  }
  actions.push(
    functionCall(
      'ft_transfer_call',
      { receiver_id: RHEA_LEND, amount, msg },
      RHEA_LEND_TOKEN_GAS,
      '1'
    )
  )
  return { receiverId: token.id, actions }
}

function unwrapTransaction(inner: bigint): NearTransaction[] {
  if (inner <= UNWRAP_ROUNDING) return []
  return [
    {
      receiverId: WRAP_NEAR,
      actions: [
        functionCall(
          'near_withdraw',
          { amount: (inner - UNWRAP_ROUNDING).toString() },
          WRAP_GAS,
          '1'
        ),
      ],
    },
  ]
}

function executeTransaction(actions: unknown[], withPrices: boolean): NearTransaction {
  return {
    receiverId: RHEA_LEND,
    actions: [
      functionCall(
        withPrices ? 'execute_with_pyth' : 'execute',
        { actions },
        withPrices ? RHEA_EXECUTE_PYTH_GAS : RHEA_EXECUTE_GAS,
        '1'
      ),
    ],
  }
}

/** One token's worth of a position, in dollars at `USD_SCALE`, the way the contract values it. */
function valueOf(inner: bigint, price: TokenPrice, extraDecimals: number): bigint {
  const places = BigInt(price.decimals + extraDecimals)
  return (inner * price.multiplier * USD_SCALE) / BigInt(10) ** places
}

interface Priced {
  assets: Map<string, AssetView>
  prices: Map<string, TokenPrice>
}

/** Assets and prices for every token named, including any this app doesn't list. */
async function readPriced(tokens: ReadonlySet<string>): Promise<Priced> {
  const ids = [...tokens]
  let infos: Awaited<ReturnType<typeof readPythInfos>>
  let assets: AssetView[]
  try {
    ;[infos, assets] = await Promise.all([
      readPythInfos(),
      Promise.all(ids.map((id) => viewCall<AssetView>(RHEA_LEND, 'get_asset', { token_id: id }))),
    ])
  } catch {
    throw cannotRead()
  }
  try {
    const prices = await Promise.all(ids.map((id) => readTokenPrice(id, infos)))
    return {
      assets: new Map(ids.map((id, index) => [id, assets[index] as AssetView])),
      prices: new Map(ids.map((id, index) => [id, prices[index] as TokenPrice])),
    }
  } catch {
    throw noPrices()
  }
}

/** Collateral counts for less than it is worth, and debt for more, by the asset's ratio. */
function collateralSum(lines: ReadonlyMap<string, bigint>, priced: Priced): bigint {
  let sum = BigInt(0)
  for (const [token, inner] of lines) {
    const { config } = priced.assets.get(token) as AssetView
    const value = valueOf(inner, priced.prices.get(token) as TokenPrice, config.extra_decimals)
    sum += (value * BigInt(config.volatility_ratio)) / BPS
  }
  return sum
}

function borrowedSum(lines: ReadonlyMap<string, bigint>, priced: Priced): bigint {
  let sum = BigInt(0)
  for (const [token, inner] of lines) {
    const { config } = priced.assets.get(token) as AssetView
    const value = valueOf(inner, priced.prices.get(token) as TokenPrice, config.extra_decimals)
    sum += (value * BPS) / BigInt(config.volatility_ratio)
  }
  return sum
}

function healthBps(collateral: bigint, borrowed: bigint): bigint {
  return borrowed === BigInt(0) ? BigInt(1_000_000) : (collateral * BPS) / borrowed
}

/** Inner units of a token worth this many scaled dollars, rounded down. */
function innerWorth(value: bigint, price: TokenPrice, extraDecimals: number): bigint {
  const places = BigInt(price.decimals + extraDecimals)
  return price.multiplier === BigInt(0)
    ? BigInt(0)
    : (value * BigInt(10) ** places) / (price.multiplier * USD_SCALE)
}

/**
 * Plain words on what liquidation means here. The drop assumes all collateral falls together while
 * the debt holds its value. The discount is the contract's own formula.
 */
function liquidationNote(health: bigint): string {
  const dropTenths = ((health - BPS) * BigInt(1000)) / health
  const drop = (Number(dropTenths) / 10).toFixed(1)
  const percent = (Number(health) / 100).toFixed(0)
  return `You can lose your collateral. After this your position stands at ${percent}% of the level Rhea Lend requires. If what backs the loan falls about ${drop}% against what you owe, or interest builds up by that much, anyone can liquidate you: they repay your debt and take your collateral at a discount. Nobody warns you first, and this app doesn't watch it for you.`
}

/** Where an open loan stands, read for someone asking where their money is. Never throws. */
async function loanWarning(holdings: Holdings): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const priced = await Promise.race([
      readPriced(new Set([...holdings.collateral.keys(), ...holdings.borrowed.keys()])),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('prices ran late')), LOAN_WARNING_READ_MS)
      }),
    ])
    const health = healthBps(
      collateralSum(holdings.collateral, priced),
      borrowedSum(holdings.borrowed, priced)
    )
    if (health <= BPS) {
      return 'This loan is at the point where anyone can liquidate it. Repay some now, or you can lose your collateral.'
    }
    const dropTenths = ((health - BPS) * BigInt(1000)) / health
    const drop = (Number(dropTenths) / 10).toFixed(1)
    const standing = `stands at ${(Number(health) / 100).toFixed(0)}% of the level Rhea Lend requires. If what backs it falls about ${drop}% against what you owe, anyone can liquidate it, and this app doesn't watch it for you.`
    return health < SAFE_HEALTH_BPS
      ? `This loan is close to being liquidated. It ${standing}`
      : `This loan ${standing}`
  } catch {
    return "I couldn't read how close this loan is to liquidation just now, so ask again in a minute."
  } finally {
    clearTimeout(timer)
  }
}

async function prepareSupply(
  request: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  assertAccount(account)
  const token = requireToken(request)
  const amount = toBaseUnits(request.amount, token.decimals)
  await assertOpen(false)

  let asset: AssetView
  let registered: boolean
  let registeredOnWrap = true
  let wallet: string | undefined
  try {
    ;[asset, registered, registeredOnWrap, wallet] = await Promise.all([
      readAsset(token),
      isRegistered(RHEA_LEND, account),
      token.id === WRAP_NEAR ? isRegistered(WRAP_NEAR, account) : Promise.resolve(true),
      token.id === WRAP_NEAR
        ? Promise.resolve(undefined)
        : viewCall<string>(token.id, 'ft_balance_of', { account_id: account }),
    ])
  } catch {
    throw cannotRead()
  }
  if (wallet !== undefined && BigInt(wallet) < BigInt(amount)) {
    throw new ChainActionRefused(
      `You hold ${formatUnits(wallet, token.decimals)} ${token.symbol}, which is less than ${request.amount}. Nothing was signed or sent.`
    )
  }
  if (!asset.config.can_deposit) {
    throw new ChainActionRefused(
      `Rhea Lend isn't taking ${token.symbol} right now. Nothing was signed or sent.`
    )
  }
  const inner = BigInt(amount) * innerScale(token)
  const limit = asset.config.supplied_limit
  if (limit !== null && BigInt(asset.supplied.balance) + inner > BigInt(limit)) {
    throw new ChainActionRefused(
      `Rhea Lend's ${token.symbol} market is full right now. Nothing was signed or sent.`
    )
  }

  const available = displayOf(availableOf(asset), token)
  return {
    venueId: RHEA_LEND_VENUE_ID,
    venueName: VENUE,
    kind: 'supply',
    summary: `Supply ${request.amount} ${token.symbol} to Rhea Lend to earn interest.`,
    pay: { amount: request.amount, symbol: token.symbol },
    apy: { basePercent: percentOf(asset.supply_apr) },
    notes: [
      `Withdrawals can be limited. ${usedPercent(asset)}% of this market is lent out, and about ${available} ${token.symbol} can leave right now. If borrowers hold the rest, you wait until they repay or new money comes in.`,
      `The rate moves with demand and isn't guaranteed. This supply isn't used to back a loan until you borrow, and it can't be liquidated until then.`,
      RISK_NOTE,
      ...(registered ? [] : [STORAGE_NOTE]),
    ],
    signing: {
      family: 'near',
      transactions: [
        ...(registered ? [] : [lendStorage(account)]),
        depositTransaction(token, amount, '', account, registeredOnWrap),
      ],
    },
  }
}

/**
 * Whatever is supplied and can back a loan is moved to do so, all of it, in a transaction of its
 * own before the borrow. In the contract a new collateral token in the same call as a borrow gets
 * a price only if the account has no position yet. Otherwise the health check has no price for it.
 */
function collateralToMove(
  holdings: Holdings,
  assets: ReadonlyMap<string, AssetView>
): { token: string; inner: bigint }[] {
  return LEND_TOKENS.flatMap((token) => {
    const inner = held(holdings.plain, token.id)
    const asset = assets.get(token.id)
    if (inner === BigInt(0) || asset === undefined || !asset.config.can_use_as_collateral) return []
    const limit = asset.config.supplied_limit
    if (limit !== null && BigInt(asset.supplied.balance) > BigInt(limit)) return []
    return [{ token: token.id, inner }]
  })
}

async function prepareBorrow(
  request: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  assertAccount(account)
  const token = requireToken(request)
  const amount = toBaseUnits(request.amount, token.decimals)
  const inner = BigInt(amount) * innerScale(token)
  await assertOpen(true)

  let holdings: Holdings
  let registeredOnToken: boolean
  let listed: AssetView[]
  try {
    ;[holdings, registeredOnToken, listed] = await Promise.all([
      readHoldings(account),
      isRegistered(token.id, account),
      Promise.all(LEND_TOKENS.map(readAsset)),
    ])
  } catch {
    throw cannotRead()
  }
  if (holdings.locked) {
    throw new ChainActionRefused(
      'Your Rhea Lend account is locked right now. Nothing was signed or sent.'
    )
  }
  const asset = listed[LEND_TOKENS.indexOf(token)] as AssetView
  const listedAssets = new Map(listed.map((a) => [a.token_id, a]))
  const moves = collateralToMove(holdings, listedAssets)

  const collateralAfter = new Map(holdings.collateral)
  for (const { token: id, inner: moved } of moves) {
    collateralAfter.set(id, held(collateralAfter, id) + moved)
  }
  if (collateralAfter.size === 0) {
    throw new ChainActionRefused(
      `Nothing of yours backs a loan on Rhea Lend yet. Supply USDC, USDT or NEAR first, then borrow. Nothing was signed or sent.`
    )
  }

  if (!asset.config.can_borrow) {
    throw new ChainActionRefused(
      `Rhea Lend isn't lending ${token.symbol} right now. Nothing was signed or sent.`
    )
  }
  const minimum = asset.config.min_borrowed_amount
  if (minimum !== null && inner < BigInt(minimum)) {
    throw new ChainActionRefused(
      `Rhea Lend lends at least ${displayOf(BigInt(minimum), token)} ${token.symbol}. Nothing was signed or sent.`
    )
  }
  const available = availableOf(asset)
  if (inner > available) {
    throw new ChainActionRefused(
      `Rhea Lend has only about ${displayOf(available, token)} ${token.symbol} free to lend right now. Nothing was signed or sent.`
    )
  }
  const limit = asset.config.borrowed_limit
  if (
    limit !== null &&
    BigInt(asset.borrowed.balance) +
      BigInt(asset.margin_debt.balance) +
      BigInt(asset.margin_pending_debt) +
      inner >
      BigInt(limit)
  ) {
    throw new ChainActionRefused(
      `Rhea Lend has reached its limit for lending ${token.symbol}. Nothing was signed or sent.`
    )
  }

  const borrowedAfter = new Map(holdings.borrowed)
  borrowedAfter.set(token.id, held(borrowedAfter, token.id) + inner)
  const priced = await readPriced(new Set([...collateralAfter.keys(), ...borrowedAfter.keys()]))
  const backing = collateralSum(collateralAfter, priced)
  const owed = borrowedSum(borrowedAfter, priced)
  const health = healthBps(backing, owed)
  if (health < SAFE_HEALTH_BPS) {
    const before = borrowedSum(holdings.borrowed, priced)
    const room = (backing * BPS) / SAFE_HEALTH_BPS - before
    const most =
      room > BigInt(0)
        ? innerWorth(
            (room * BigInt(asset.config.volatility_ratio)) / BPS,
            priced.prices.get(token.id) as TokenPrice,
            asset.config.extra_decimals
          )
        : BigInt(0)
    throw new ChainActionRefused(
      most > BigInt(0)
        ? `What you've supplied can't safely back ${request.amount} ${token.symbol}. You could borrow about ${displayOf(most, token)} ${token.symbol}, or supply more first. Nothing was signed or sent.`
        : `What you've supplied can't safely back any more borrowing. Repay some or supply more first. Nothing was signed or sent.`
    )
  }

  const transactions: NearTransaction[] = [
    ...(registeredOnToken ? [] : [{ receiverId: token.id, actions: [tokenStorage(account)] }]),
    ...(moves.length > 0
      ? [
          executeTransaction(
            moves.map((move) => ({ IncreaseCollateral: { token_id: move.token } })),
            true
          ),
        ]
      : []),
    executeTransaction(
      [
        { Borrow: { token_id: token.id, amount: inner.toString() } },
        { Withdraw: { token_id: token.id, max_amount: inner.toString() } },
      ],
      true
    ),
    ...(token.id === WRAP_NEAR ? unwrapTransaction(inner) : []),
  ]
  const symbols = (id: string): string => LEND_TOKENS.find((t) => t.id === id)?.symbol ?? id
  return {
    venueId: RHEA_LEND_VENUE_ID,
    venueName: VENUE,
    kind: 'borrow',
    summary: `Borrow ${request.amount} ${token.symbol} from Rhea Lend, backed by what you've supplied.`,
    pay: { amount: request.amount, symbol: token.symbol },
    receive: { amount: request.amount, symbol: token.symbol, approximate: false },
    apy: { basePercent: percentOf(asset.borrow_apr) },
    notes: [
      liquidationNote(health),
      `The rate shown is what you pay, about ${percentOf(asset.borrow_apr).toFixed(2)}% a year right now. It moves with demand, and what you owe keeps growing until you repay.`,
      ...(moves.length > 0
        ? [
            `All your supplied ${moves.map((m) => symbols(m.token)).join(' and ')} now backs this loan, so taking it out later is checked against what you owe.`,
          ]
        : []),
      `This takes ${transactions.length} transaction${transactions.length === 1 ? '' : 's'} in your wallet.${registeredOnToken ? '' : ` One pays 0.00125 NEAR to register you on ${token.symbol}.`} It uses Pyth's price at the moment it runs, and if that price is out of date the loan fails and nothing moves.`,
      ...(token.id === WRAP_NEAR
        ? [
            'NEAR arrives as wNEAR and the last step turns it into NEAR. If that step fails you still hold it as wNEAR, and "withdraw NEAR on Rhea DEX" turns it back.',
          ]
        : []),
      RISK_NOTE,
    ],
    signing: { family: 'near', transactions },
  }
}

async function prepareWithdraw(
  request: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  assertAccount(account)
  const token = requireToken(request)
  await assertOpen(false)

  let holdings: Holdings
  let asset: AssetView
  let registeredOnToken: boolean
  try {
    ;[holdings, asset, registeredOnToken] = await Promise.all([
      readHoldings(account),
      readAsset(token),
      isRegistered(token.id, account),
    ])
  } catch {
    throw cannotRead()
  }
  if (holdings.locked) {
    throw new ChainActionRefused(
      'Your Rhea Lend account is locked right now. Nothing was signed or sent.'
    )
  }
  const plain = held(holdings.plain, token.id)
  const collateral = held(holdings.collateral, token.id)
  const total = plain + collateral
  if (total === BigInt(0)) {
    throw new ChainActionRefused(
      `You have no ${token.symbol} to withdraw on Rhea Lend. Nothing was signed or sent.`
    )
  }
  const whole = request.wholePosition === true
  const asked = whole
    ? total
    : BigInt(toBaseUnits(request.amount, token.decimals)) * innerScale(token)
  if (asked > total) {
    throw new ChainActionRefused(
      `You have ${displayOf(total, token)} ${token.symbol} on Rhea Lend, which is less than ${request.amount}. Nothing was signed or sent.`
    )
  }
  if (!asset.config.can_withdraw) {
    throw new ChainActionRefused(
      `Rhea Lend has stopped withdrawals of ${token.symbol} right now. Nothing was signed or sent.`
    )
  }
  const available = availableOf(asset)
  if (asked > available) {
    throw new ChainActionRefused(
      `Only about ${displayOf(available, token)} ${token.symbol} can leave Rhea Lend right now, because borrowers hold the rest. You can withdraw that much, or try again once they repay. Nothing was signed or sent.`
    )
  }

  const gap = asked > plain ? asked - plain : BigInt(0)
  const needsPrices = gap > BigInt(0)
  let health: bigint | undefined
  if (needsPrices && holdings.borrowed.size > 0) {
    await assertOpen(true)
    const collateralAfter = new Map(holdings.collateral)
    const left = collateral - gap
    if (left > BigInt(0)) collateralAfter.set(token.id, left)
    else collateralAfter.delete(token.id)
    const priced = await readPriced(
      new Set([...holdings.collateral.keys(), ...holdings.borrowed.keys()])
    )
    const backing = collateralSum(collateralAfter, priced)
    const owed = borrowedSum(holdings.borrowed, priced)
    health = healthBps(backing, owed)
    if (health < SAFE_HEALTH_BPS) {
      const spare = collateralSum(holdings.collateral, priced) - (owed * SAFE_HEALTH_BPS) / BPS
      const most =
        spare > BigInt(0)
          ? innerWorth(
              (spare * BPS) / BigInt(asset.config.volatility_ratio),
              priced.prices.get(token.id) as TokenPrice,
              asset.config.extra_decimals
            )
          : BigInt(0)
      const capped = most < collateral ? most : collateral
      throw new ChainActionRefused(
        capped + plain > BigInt(0)
          ? `That would leave your loan on Rhea Lend without enough behind it. You could take out about ${displayOf(capped + plain, token)} ${token.symbol}, or repay first. Nothing was signed or sent.`
          : `All of this is backing your loan on Rhea Lend, so repay first, then withdraw. Nothing was signed or sent.`
      )
    }
  } else if (needsPrices) {
    await assertOpen(true)
  }

  // No amount is the contract's "all of it", which leaves no interest behind.
  const release = whole || gap >= collateral ? {} : { amount: gap.toString() }
  const withdraw = whole ? {} : { max_amount: asked.toString() }
  const actions = [
    ...(needsPrices ? [{ DecreaseCollateral: { token_id: token.id, ...release } }] : []),
    { Withdraw: { token_id: token.id, ...withdraw } },
  ]
  const transactions: NearTransaction[] = [
    ...(registeredOnToken ? [] : [{ receiverId: token.id, actions: [tokenStorage(account)] }]),
    executeTransaction(actions, needsPrices),
    ...(token.id === WRAP_NEAR ? unwrapTransaction(asked) : []),
  ]
  const display = displayOf(asked, token)
  return {
    venueId: RHEA_LEND_VENUE_ID,
    venueName: VENUE,
    kind: 'withdraw',
    summary: `Withdraw ${whole ? 'all your' : display} ${token.symbol} from Rhea Lend to your wallet.`,
    pay: { amount: display, symbol: token.symbol },
    receive: { amount: display, symbol: token.symbol, approximate: whole },
    notes: [
      `This goes to the account that signs, with no fee beyond network gas. About ${displayOf(available, token)} ${token.symbol} can leave right now, and if others withdraw first this can fail with nothing moved.`,
      ...(needsPrices
        ? [
            "Part of this is backing for a loan or marked as collateral, so it runs with Pyth's price at that moment. If that price is out of date it fails and nothing moves.",
          ]
        : []),
      ...(health !== undefined ? [liquidationNote(health)] : []),
      ...(token.id === WRAP_NEAR
        ? [
            'NEAR arrives as wNEAR and the last step turns it into NEAR. If that step fails you still hold it as wNEAR, and "withdraw NEAR on Rhea DEX" turns it back.',
          ]
        : []),
      ...(transactions.length > 1
        ? [
            `This takes ${transactions.length} transactions in your wallet.${registeredOnToken ? '' : ` One pays 0.00125 NEAR to register you on ${token.symbol}.`}`,
          ]
        : []),
    ],
    signing: { family: 'near', transactions },
  }
}

async function prepareRepay(request: ChainActionRequest, account: string): Promise<PreparedAction> {
  assertAccount(account)
  const token = requireToken(request)
  await assertOpen(false)

  let holdings: Holdings
  let registeredOnWrap = true
  let wallet: string | undefined
  try {
    ;[holdings, , registeredOnWrap, wallet] = await Promise.all([
      readHoldings(account),
      readAsset(token),
      token.id === WRAP_NEAR ? isRegistered(WRAP_NEAR, account) : Promise.resolve(true),
      token.id === WRAP_NEAR
        ? Promise.resolve(undefined)
        : viewCall<string>(token.id, 'ft_balance_of', { account_id: account }),
    ])
  } catch {
    throw cannotRead()
  }
  if (holdings.locked) {
    throw new ChainActionRefused(
      'Your Rhea Lend account is locked right now. Nothing was signed or sent.'
    )
  }
  const owedInner = held(holdings.borrowed, token.id)
  if (owedInner === BigInt(0)) {
    throw new ChainActionRefused(
      `You don't owe any ${token.symbol} on Rhea Lend. Nothing was signed or sent.`
    )
  }
  const scale = innerScale(token)
  const owed = (owedInner + scale - BigInt(1)) / scale
  const margin = owed / REPAY_MARGIN_DIVISOR + BigInt(1)
  const payingOff = request.wholePosition === true
  let sending = payingOff ? owed + margin : BigInt(toBaseUnits(request.amount, token.decimals))
  if (!payingOff && sending > owed + margin) {
    throw new ChainActionRefused(
      `You owe about ${formatUnits(owed.toString(), token.decimals)} ${token.symbol} on Rhea Lend, which is less than ${request.amount}. Say "repay all ${token.symbol}" to clear it. Nothing was signed or sent.`
    )
  }
  if (wallet !== undefined) {
    const inWallet = BigInt(wallet)
    if (payingOff && inWallet < sending && inWallet >= owed) sending = inWallet
    if (inWallet < sending) {
      throw new ChainActionRefused(
        `You hold ${formatUnits(wallet, token.decimals)} ${token.symbol}, and this needs ${formatUnits(sending.toString(), token.decimals)}. Repay a smaller amount, or get more first. Nothing was signed or sent.`
      )
    }
  }

  const msg = JSON.stringify({
    Execute: {
      actions: [{ Repay: { token_id: token.id, max_amount: (sending * scale).toString() } }],
    },
  })
  const display = formatUnits(sending.toString(), token.decimals)
  return {
    venueId: RHEA_LEND_VENUE_ID,
    venueName: VENUE,
    kind: 'repay',
    summary: payingOff
      ? `Pay off your ${token.symbol} loan on Rhea Lend.`
      : `Repay ${display} ${token.symbol} on Rhea Lend.`,
    pay: { amount: display, symbol: token.symbol },
    notes: [
      payingOff
        ? `You owe about ${formatUnits(owed.toString(), token.decimals)} ${token.symbol}. This sends a little over, because interest grows until it runs. Anything left over stays as your supply on Rhea Lend and can be withdrawn.`
        : `You owe about ${formatUnits(owed.toString(), token.decimals)} ${token.symbol}, and it keeps growing until it is repaid.`,
      'This uses only what is sent here. It takes nothing else you hold on Rhea Lend.',
      ...(token.id === WRAP_NEAR && !registeredOnWrap
        ? ['This also pays 0.00125 NEAR to register you on wNEAR.']
        : []),
    ],
    signing: {
      family: 'near',
      transactions: [depositTransaction(token, sending.toString(), msg, account, registeredOnWrap)],
    },
  }
}

function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
  switch (request.kind) {
    case 'supply':
      return prepareSupply(request, account)
    case 'borrow':
      return prepareBorrow(request, account)
    case 'withdraw':
      return prepareWithdraw(request, account)
    case 'repay':
      return prepareRepay(request, account)
    default:
      throw new ChainActionRefused(`${VENUE} can't ${request.kind.replace('_', ' ')} here.`)
  }
}

/** A rate read from the contract, and nothing for kinds with no rate to compare. */
async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
  assertAccount(account)
  if (request.kind !== 'supply') return {}
  const token = requireToken(request)
  try {
    const asset = await readAsset(token)
    return { apyPercent: percentOf(asset.supply_apr) }
  } catch {
    throw cannotRead()
  }
}

/**
 * Live figures from the contract, interest included. A failed read throws, so it is never taken
 * for an empty position. Tokens this app doesn't list can't be exited here, so aren't shown.
 */
async function positions(account: string): Promise<VenuePosition[]> {
  assertAccount(account)
  const holdings = await readHoldings(account)
  const read: VenuePosition[] = LEND_TOKENS.flatMap((token) => {
    const supplied = held(holdings.plain, token.id) + held(holdings.collateral, token.id)
    const borrowed = held(holdings.borrowed, token.id)
    return [
      ...(supplied > BigInt(0)
        ? [{ slot: 'supplied' as const, symbol: token.symbol, amount: displayOf(supplied, token) }]
        : []),
      ...(borrowed > BigInt(0)
        ? [{ slot: 'borrowed' as const, symbol: token.symbol, amount: displayOf(borrowed, token) }]
        : []),
    ]
  })
  const firstLoan = read.find((position) => position.slot === 'borrowed')
  if (firstLoan !== undefined) firstLoan.warning = await loanWarning(holdings)
  return read
}

/** After a swap, only what arrives in a known form: a swap to NEAR can arrive as NEAR or wNEAR. */
const stablesOnly = takesOnly(VENUE, ['USDC', 'USDT'])

async function assertCanFollow(step: FollowOnStep, account: string): Promise<void> {
  if (step.kind !== 'supply' && step.kind !== 'repay') {
    throw new ChainActionRefused(`${VENUE} can't ${step.kind} straight after a swap. Do it next.`)
  }
  await stablesOnly(step, account)
}

function isLendCall(receiver: string): boolean {
  return receiver === RHEA_LEND || LEND_TOKENS.some((token) => token.id === receiver)
}

const LEND_METHODS: ReadonlySet<string> = new Set([
  'ft_transfer_call',
  'execute',
  'execute_with_pyth',
  'near_withdraw',
])

function notThisVenue(hash: string): SubmitResult {
  return {
    ok: false,
    pending: true,
    error: `Transaction ${hash} is not this account's on Rhea Lend. Check your wallet's activity.`,
  }
}

function logsEvent(logs: readonly string[], event: string): boolean {
  return logs.some((line) => line.startsWith('EVENT_JSON:') && line.includes(`"event":"${event}"`))
}

/**
 * Confirms what a wallet already sent. A call that fetches prices first returns before its work
 * runs, so its transaction reads as a success even if the loan was refused. So this reads the
 * receipts, and says where the money is rather than calling it done.
 */
export async function confirmRheaLend(input: SubmitInput): Promise<SubmitResult> {
  const { account, signed } = input
  if (signed.family !== 'near') return { ok: false, error: 'That is not a NEAR transaction.' }
  const hash = signed.hashes[signed.hashes.length - 1]
  if (hash === undefined || signed.hashes.some((h) => !NEAR_TX_HASH.test(h))) {
    return {
      ok: false,
      pending: true,
      error: 'The wallet did not return a transaction hash to follow.',
    }
  }

  const giveUpAt = Date.now() + CONFIRM_WAIT_MS
  let moved = false
  for (const each of signed.hashes) {
    const outcome = await followTransaction(each, account, Math.max(giveUpAt - Date.now(), 1))
    if (outcome.state === 'unknown') {
      return {
        ok: false,
        pending: true,
        error: `Your transaction was sent (${each}) but hasn't been confirmed yet. Don't send it again. Check ${explorerUrl(each)} in a minute.`,
      }
    }
    if (outcome.signer !== account || !isLendCall(outcome.receiver)) {
      return {
        ok: false,
        pending: true,
        error: `Transaction ${each} is not this account's on Rhea Lend. Check your wallet's activity.`,
      }
    }
    const registers = outcome.calls.every((c) => c.method === 'storage_deposit')
    const unwraps = outcome.calls.every((c) => c.method === 'near_withdraw')
    const refused =
      outcome.state === 'failed' ||
      outcome.receipts.some((r) => r.failed && r.executor === RHEA_LEND)

    if (refused) {
      if (registers && each !== hash) continue
      if (unwraps && moved) {
        return {
          ok: false,
          pending: true,
          error: `Your NEAR reached your wallet as wNEAR, but turning it into NEAR failed (${each}). Say "withdraw NEAR on Rhea DEX" to turn it back.`,
        }
      }
      return {
        ok: false,
        ...(moved ? { pending: true } : {}),
        error: moved
          ? `Part of this went through and part failed (${each}). Check your balances before trying again, and see ${explorerUrl(each)}.`
          : `Rhea Lend didn't take this (${each}), so nothing moved, apart from the gas. A price that was out of date or a change in your position can cause it. You can try again.`,
      }
    }
    if (registers) continue
    if (!outcome.calls.some((c) => LEND_METHODS.has(c.method))) return notThisVenue(each)

    if (outcome.calls.some((c) => c.method === 'ft_transfer_call')) {
      const kept = amountKept(outcome.returned)
      if (kept === undefined) {
        return {
          ok: false,
          pending: true,
          error: `Your transaction ran (${each}), but its result couldn't be read. Don't send it again. Check ${explorerUrl(each)}.`,
        }
      }
      if (kept === BigInt(0)) {
        return {
          ok: false,
          error:
            outcome.receiver === WRAP_NEAR
              ? `Rhea Lend didn't take this (${each}), and your NEAR came back as wNEAR in your wallet. Say "withdraw NEAR on Rhea DEX" to turn it back.`
              : `Rhea Lend didn't take this (${each}), and your tokens came back to your wallet. You can try again.`,
        }
      }
    }
    if (outcome.receipts.some((r) => logsEvent(r.logs, 'withdraw_failed'))) {
      return {
        ok: false,
        pending: true,
        error: `The tokens couldn't reach your wallet (${each}), so they are back as your supply on Rhea Lend. Check your balance there, then withdraw again. If this was a loan, you still owe it.`,
      }
    }
    moved = true
  }
  // Registering alone isn't what was asked, and a hash from elsewhere must not read as done.
  return moved ? { ok: true, hash, explorerUrl: explorerUrl(hash) } : notThisVenue(hash)
}

export const rheaLendVenue: ChainVenue = {
  id: RHEA_LEND_VENUE_ID,
  name: VENUE,
  kinds: ['supply', 'withdraw', 'borrow', 'repay'],
  assertCanFollow,
  quote,
  prepare,
  positions,
  assertSafe: assertRheaLendSafe,
  submit: confirmRheaLend,
}
