import {
  ChainActionRefused,
  toBaseUnits,
  tokenBySymbol,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
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
  usdPerToken,
} from './rhea-read'
import {
  assertRheaDexSafe,
  RHEA_DEX,
  RHEA_EXIT_GAS,
  RHEA_POOLS,
  RHEA_SWAP_GAS,
} from './rhea-safety'
import { isRegistered, viewCall } from './rpc'
import { STORAGE_DEPOSIT_YOCTO, STORAGE_GAS, WRAP_GAS } from './safety'
import {
  explorerUrl,
  formatUnits,
  nearTokens,
  toDisplayNumber,
  USDC_NEAR,
  USDT_NEAR,
  WRAP_NEAR,
} from './tokens'

export const RHEA_DEX_VENUE_ID = 'rhea-dex'
const VENUE = 'Rhea DEX'

const SLIPPAGE_BPS = BigInt(100)
/** A swap worth this much less than it costs is refused, the same line as 1Click's. */
const MAX_VALUE_LOSS = 0.05
const CONFIRM_WAIT_MS = 25_000

/**
 * The routes this venue may take, deepest pools first. Two steps cross a stablecoin pool, for a
 * pair with less depth of its own. What each pays is read from the chain each time.
 */
const ROUTES: readonly { from: string; to: string; pools: readonly number[][] }[] = [
  { from: WRAP_NEAR, to: USDC_NEAR, pools: [[4512], [5515], [6063, 6416]] },
  { from: WRAP_NEAR, to: USDT_NEAR, pools: [[6063], [4512, 6416], [5515, 6416]] },
  { from: USDC_NEAR, to: USDT_NEAR, pools: [[6416], [4179]] },
]

const RISK_NOTE =
  "Rhea's exchange contract can be changed by the DAO that owns it, ref-finance.sputnik-dao.near. Its source is no longer at the address Rhea published, so this app read a third party's copy of version 1.9.18 and checked it against the deployed 1.9.21 and real swaps. Rhea lost about $18.4M in April 2026 through a margin feature on its lending side, since shut down."

function cannotRead(): ChainActionRefused {
  return new ChainActionRefused(
    'Rhea DEX could not be read from NEAR just now, so nothing was built. Try again in a minute. Nothing was signed or sent.'
  )
}

function assertAccount(account: string): void {
  if (!NEAR_ACCOUNT.test(account)) {
    throw new ChainActionRefused('That is not a NEAR account. Connect a NEAR wallet and try again.')
  }
}

function functionCall(
  methodName: string,
  args: Record<string, unknown>,
  gas: bigint,
  deposit: string
): NearTransaction['actions'][number] {
  return { type: 'FunctionCall', params: { methodName, args, gas: gas.toString(), deposit } }
}

function storageFor(account: string): NearTransaction['actions'][number] {
  return functionCall(
    'storage_deposit',
    { account_id: account, registration_only: true },
    STORAGE_GAS,
    STORAGE_DEPOSIT_YOCTO
  )
}

/** The pools of a route, in the order the money crosses them, with each step's tokens. */
function stepsOf(pools: readonly number[], from: string, to: string): StepTokens[] {
  const [first, second] = pools as [number, number | undefined]
  if (second === undefined) return [{ pool: first, tokenIn: from, tokenOut: to }]
  const firstTokens = RHEA_POOLS[first] as readonly string[]
  const middle = firstTokens.find((token) => token !== from) as string
  return [
    { pool: first, tokenIn: from, tokenOut: middle },
    { pool: second, tokenIn: middle, tokenOut: to },
  ]
}

interface StepTokens {
  pool: number
  tokenIn: string
  tokenOut: string
}

interface Route {
  steps: StepTokens[]
  amountOut: bigint
  fees: number[]
}

function routesBetween(tokenIn: string, tokenOut: string): StepTokens[][] {
  return ROUTES.flatMap(({ from, to, pools }) => {
    if (from === tokenIn && to === tokenOut) return pools.map((p) => stepsOf(p, from, to))
    if (from === tokenOut && to === tokenIn) {
      return pools.map((p) => stepsOf([...p].reverse(), to, from))
    }
    return []
  })
}

interface PoolInfo {
  token_account_ids: string[]
  amounts: string[]
  total_fee: number
}

async function assertExchangeOpen(tokens: readonly string[]): Promise<void> {
  let state: string
  let frozen: string[]
  try {
    const [metadata, frozenList] = await Promise.all([
      viewCall<{ state: string }>(RHEA_DEX, 'metadata'),
      viewCall<string[]>(RHEA_DEX, 'get_frozenlist_tokens'),
    ])
    state = metadata.state
    frozen = frozenList
  } catch {
    throw cannotRead()
  }
  if (state !== 'Running') {
    throw new ChainActionRefused('Rhea DEX is paused right now. Nothing was signed or sent.')
  }
  if (tokens.some((token) => frozen.includes(token))) {
    throw new ChainActionRefused(
      'Rhea DEX has frozen one of these tokens right now. Nothing was signed or sent.'
    )
  }
}

/** What a route pays, read from the chain step by step, or nothing if a pool won't quote it. */
async function readRoute(
  steps: StepTokens[],
  amount: string,
  pools: Map<number, PoolInfo>
): Promise<Route | undefined> {
  const fees: number[] = []
  let running = amount
  try {
    for (const step of steps) {
      const pool = pools.get(step.pool)
      if (
        pool === undefined ||
        !pool.token_account_ids.includes(step.tokenIn) ||
        !pool.token_account_ids.includes(step.tokenOut)
      ) {
        return undefined
      }
      fees.push(pool.total_fee)
      running = await viewCall<string>(RHEA_DEX, 'get_return', {
        pool_id: step.pool,
        token_in: step.tokenIn,
        amount_in: running,
        token_out: step.tokenOut,
      })
    }
  } catch {
    // A pool priced by an oracle refuses to quote while its price is stale. The swap would too.
    return undefined
  }
  const amountOut = BigInt(running)
  return amountOut > BigInt(0) ? { steps, amountOut, fees } : undefined
}

async function bestRoute(
  tokenIn: ChainToken,
  tokenOut: ChainToken,
  amount: string
): Promise<Route> {
  await assertExchangeOpen([tokenIn.id, tokenOut.id])
  const candidates = routesBetween(tokenIn.id, tokenOut.id)
  const ids = [...new Set(candidates.flat().map((step) => step.pool))]
  let infos: PoolInfo[]
  try {
    infos = await viewCall<PoolInfo[]>(RHEA_DEX, 'get_pool_by_ids', { pool_ids: ids })
  } catch {
    throw cannotRead()
  }
  const pools = new Map(ids.map((id, index) => [id, infos[index] as PoolInfo]))
  const read = await Promise.all(candidates.map((steps) => readRoute(steps, amount, pools)))
  const best = read
    .flatMap((route) => (route === undefined ? [] : [route]))
    .reduce<
      Route | undefined
    >((top, route) => (top === undefined || route.amountOut > top.amountOut ? route : top), undefined)
  if (best === undefined) {
    throw new ChainActionRefused(
      `Rhea DEX has no pool that will quote ${tokenIn.symbol} to ${tokenOut.symbol} right now. Try again in a minute. Nothing was signed or sent.`
    )
  }
  return best
}

/**
 * Measured against Pyth, which the pools don't set for themselves: a pool can be drained or pushed,
 * and its own quote would still look fine. A swap with no price to check against is not sent.
 */
async function assertFairValue(
  tokenIn: ChainToken,
  tokenOut: ChainToken,
  amount: string,
  amountOut: bigint
): Promise<number> {
  let loss: number
  try {
    const infos = await readPythInfos()
    const [priceIn, priceOut] = await Promise.all([
      readTokenPrice(tokenIn.id, infos),
      readTokenPrice(tokenOut.id, infos),
    ])
    const paid = toDisplayNumber(amount, tokenIn.decimals) * usdPerToken(priceIn, tokenIn.decimals)
    const received =
      toDisplayNumber(amountOut.toString(), tokenOut.decimals) *
      usdPerToken(priceOut, tokenOut.decimals)
    loss = 1 - received / paid
  } catch {
    throw new ChainActionRefused(
      "This swap couldn't be checked against live prices, so it was not used. Try again in a minute. Nothing was signed or sent."
    )
  }
  if (!Number.isFinite(loss)) {
    throw new ChainActionRefused(
      "This swap couldn't be checked against live prices, so it was not used. Try again in a minute. Nothing was signed or sent."
    )
  }
  if (loss > MAX_VALUE_LOSS) {
    throw new ChainActionRefused(
      `You would get about ${(loss * 100).toFixed(1)}% less than you pay, which is more than this app allows. Try a smaller amount. Nothing was signed or sent.`
    )
  }
  return loss
}

function swapTokens(request: ChainActionRequest): { tokenIn: ChainToken; tokenOut: ChainToken } {
  const tokenIn = tokenBySymbol(nearTokens, request.tokenIn)
  const tokenOut = tokenBySymbol(nearTokens, request.tokenOut ?? '')
  if (request.kind !== 'swap' || tokenIn === undefined || tokenOut === undefined) {
    throw new ChainActionRefused(`${VENUE} here swaps between NEAR, USDC and USDT.`)
  }
  if (tokenIn.id === tokenOut.id) throw new ChainActionRefused('Those are the same token.')
  return { tokenIn, tokenOut }
}

async function quoteSwap(request: ChainActionRequest, account: string): Promise<VenueQuote> {
  assertAccount(account)
  const { tokenIn, tokenOut } = swapTokens(request)
  const amount = toBaseUnits(request.amount, tokenIn.decimals)
  const route = await bestRoute(tokenIn, tokenOut, amount)
  await assertFairValue(tokenIn, tokenOut, amount, route.amountOut)
  return {
    receive: {
      amount: formatUnits(route.amountOut.toString(), tokenOut.decimals),
      symbol: tokenOut.symbol,
    },
  }
}

/** The message `ft_transfer_call` carries. The exact shape `assertRheaDexSafe` allows. */
export function swapMessage(route: Route, amount: string, minOut: bigint): string {
  const last = route.steps.length - 1
  const actions = route.steps.map((step, index) => ({
    pool_id: step.pool,
    token_in: step.tokenIn,
    token_out: step.tokenOut,
    ...(index === 0 ? { amount_in: amount } : {}),
    // Only the end of a route matters. Rhea's own swaps also leave the middle at zero.
    min_amount_out: index === last ? minOut.toString() : '0',
  }))
  const toNear = route.steps[last]?.tokenOut === WRAP_NEAR
  return JSON.stringify({ actions, ...(toNear ? { skip_unwrap_near: false } : {}) })
}

async function prepareSwap(request: ChainActionRequest, account: string): Promise<PreparedAction> {
  assertAccount(account)
  const { tokenIn, tokenOut } = swapTokens(request)
  const amount = toBaseUnits(request.amount, tokenIn.decimals)
  const route = await bestRoute(tokenIn, tokenOut, amount)
  const loss = await assertFairValue(tokenIn, tokenOut, amount, route.amountOut)
  const minOut = (route.amountOut * (BigInt(10_000) - SLIPPAGE_BPS)) / BigInt(10_000)

  const fromNear = tokenIn.id === WRAP_NEAR
  const toNear = tokenOut.id === WRAP_NEAR
  let registeredOut = true
  let registeredWrap = true
  let held: string | undefined
  try {
    ;[registeredOut, registeredWrap, held] = await Promise.all([
      toNear ? Promise.resolve(true) : isRegistered(tokenOut.id, account),
      fromNear ? isRegistered(WRAP_NEAR, account) : Promise.resolve(true),
      fromNear
        ? Promise.resolve(undefined)
        : viewCall<string>(tokenIn.id, 'ft_balance_of', { account_id: account }),
    ])
  } catch {
    throw cannotRead()
  }
  if (held !== undefined && BigInt(held) < BigInt(amount)) {
    throw new ChainActionRefused(
      `You hold ${formatUnits(held, tokenIn.decimals)} ${tokenIn.symbol}, which is less than ${request.amount}. Nothing was signed or sent.`
    )
  }

  const actions: NearTransaction['actions'] = []
  if (fromNear) {
    if (!registeredWrap) actions.push(storageFor(account))
    actions.push(functionCall('near_deposit', {}, WRAP_GAS, amount))
  }
  actions.push(
    functionCall(
      'ft_transfer_call',
      { receiver_id: RHEA_DEX, amount, msg: swapMessage(route, amount, minOut) },
      RHEA_SWAP_GAS,
      '1'
    )
  )
  const transactions: NearTransaction[] = [
    ...(registeredOut ? [] : [{ receiverId: tokenOut.id, actions: [storageFor(account)] }]),
    { receiverId: tokenIn.id, actions },
  ]

  const minimum = formatUnits(minOut.toString(), tokenOut.decimals)
  const fee = route.fees.map((bps) => `${(bps / 100).toFixed(2)}%`).join(' and ')
  const refund = fromNear
    ? `Your NEAR comes back as wNEAR, the same value in its wrapped form, and "withdraw NEAR on Rhea DEX" turns it back.`
    : `Your ${tokenIn.symbol} comes back to your wallet.`
  return {
    venueId: RHEA_DEX_VENUE_ID,
    venueName: VENUE,
    kind: 'swap',
    summary: `Swap ${request.amount} ${tokenIn.symbol} for ${tokenOut.symbol} on Rhea DEX, sent straight to your wallet.`,
    pay: { amount: request.amount, symbol: tokenIn.symbol },
    receive: {
      amount: formatUnits(route.amountOut.toString(), tokenOut.decimals),
      symbol: tokenOut.symbol,
      approximate: true,
    },
    notes: [
      `You get at least ${minimum} ${tokenOut.symbol}, or the swap stops. ${refund} The price includes the pool fee of ${fee}, and after all costs you get about ${(Math.max(loss, 0) * 100).toFixed(2)}% less in value than you pay, going by Pyth's prices.`,
      `Your ${tokenOut.symbol} is sent to your wallet as part of the swap, not left at Rhea. If that last step ever failed, it would wait under your name at Rhea, and "withdraw ${tokenOut.symbol} on Rhea DEX" or "claim ${tokenOut.symbol} on Rhea DEX" gets it out.`,
      ...(registeredOut
        ? []
        : [
            `This takes two transactions. The first pays 0.00125 NEAR to register you on ${tokenOut.symbol}, so it can reach you.`,
          ]),
      ...(registeredWrap ? [] : ['This also pays 0.00125 NEAR to register you on wNEAR.']),
      RISK_NOTE,
    ],
    signing: { family: 'near', transactions },
  }
}

interface Holdings {
  atRhea: Record<string, string>
  lost: Record<string, string>
  wrappedInWallet: string
}

async function readHoldings(account: string): Promise<Holdings> {
  const [atRhea, lost, wrappedInWallet] = await Promise.all([
    viewCall<Record<string, string>>(RHEA_DEX, 'get_deposits', { account_id: account }),
    viewCall<Record<string, string>>(RHEA_DEX, 'list_lostfound_tokens', { account_id: account }),
    viewCall<string>(WRAP_NEAR, 'ft_balance_of', { account_id: account }),
  ])
  return { atRhea, lost, wrappedInWallet }
}

function amountIn(record: Record<string, string>, token: string): bigint {
  const value = Object.prototype.hasOwnProperty.call(record, token) ? record[token] : undefined
  return value === undefined ? BigInt(0) : BigInt(value)
}

/**
 * What can be taken back from this venue: a balance held at Rhea, and wNEAR in the wallet, which is
 * what a swap from NEAR hands back when it stops. Reads throw, so a failed read is never "nothing".
 */
async function positions(account: string): Promise<VenuePosition[]> {
  assertAccount(account)
  const holdings = await readHoldings(account)
  return nearTokens.flatMap((token) => {
    const supplied =
      amountIn(holdings.atRhea, token.id) +
      (token.id === WRAP_NEAR ? BigInt(holdings.wrappedInWallet) : BigInt(0))
    const lost = amountIn(holdings.lost, token.id)
    return [
      ...(supplied > BigInt(0)
        ? [
            {
              slot: 'supplied' as const,
              symbol: token.symbol,
              amount: formatUnits(supplied.toString(), token.decimals),
            },
          ]
        : []),
      ...(lost > BigInt(0)
        ? [
            {
              slot: 'claimable' as const,
              symbol: token.symbol,
              amount: formatUnits(lost.toString(), token.decimals),
            },
          ]
        : []),
    ]
  })
}

function unwrapTransaction(amount: bigint): NearTransaction {
  return {
    receiverId: WRAP_NEAR,
    actions: [functionCall('near_withdraw', { amount: amount.toString() }, WRAP_GAS, '1')],
  }
}

function exitToken(request: ChainActionRequest): ChainToken {
  const token = tokenBySymbol(nearTokens, request.tokenIn)
  if (token === undefined) {
    throw new ChainActionRefused(`${VENUE} here holds NEAR, USDC and USDT.`)
  }
  return token
}

async function prepareWithdraw(
  request: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  assertAccount(account)
  const token = exitToken(request)
  let holdings: Holdings
  let registered = true
  try {
    ;[holdings, registered] = await Promise.all([
      readHoldings(account),
      token.id === WRAP_NEAR ? Promise.resolve(true) : isRegistered(token.id, account),
    ])
  } catch {
    throw cannotRead()
  }
  const atRhea = amountIn(holdings.atRhea, token.id)
  const inWallet = token.id === WRAP_NEAR ? BigInt(holdings.wrappedInWallet) : BigInt(0)
  const total = atRhea + inWallet
  if (total === BigInt(0)) {
    throw new ChainActionRefused(
      `You have no ${token.symbol} to take back from Rhea DEX. Nothing was signed or sent.`
    )
  }
  const whole = request.wholePosition === true
  const asked = whole ? total : BigInt(toBaseUnits(request.amount, token.decimals))
  if (asked > total) {
    throw new ChainActionRefused(
      `You have ${formatUnits(total.toString(), token.decimals)} ${token.symbol} to take back from Rhea DEX, which is less than ${request.amount}. Nothing was signed or sent.`
    )
  }
  const fromRhea = asked < atRhea ? asked : atRhea
  const fromWallet = asked - fromRhea

  const transactions: NearTransaction[] = []
  if (!registered) transactions.push({ receiverId: token.id, actions: [storageFor(account)] })
  if (fromRhea > BigInt(0)) {
    transactions.push({
      receiverId: RHEA_DEX,
      actions: [
        functionCall(
          'withdraw',
          {
            token_id: token.id,
            // Zero is the contract's "all of it", which leaves nothing behind.
            amount: whole ? '0' : fromRhea.toString(),
            ...(token.id === WRAP_NEAR ? { skip_unwrap_near: false } : {}),
          },
          RHEA_EXIT_GAS,
          '1'
        ),
      ],
    })
  }
  if (fromWallet > BigInt(0)) transactions.push(unwrapTransaction(fromWallet))

  const display = formatUnits(asked.toString(), token.decimals)
  return {
    venueId: RHEA_DEX_VENUE_ID,
    venueName: VENUE,
    kind: 'withdraw',
    summary:
      fromRhea > BigInt(0)
        ? `Take ${display} ${token.symbol} back from Rhea DEX into your wallet.`
        : `Turn ${display} wNEAR in your wallet back into NEAR.`,
    pay: { amount: display, symbol: token.symbol },
    receive: { amount: display, symbol: token.symbol, approximate: false },
    notes: [
      'This only moves what is already yours, back to the account that signs. There is no fee beyond network gas.',
      ...(transactions.length > 1
        ? [
            `This takes ${transactions.length} transactions in your wallet.${registered ? '' : ` One pays 0.00125 NEAR to register you on ${token.symbol}.`}`,
          ]
        : []),
    ],
    signing: { family: 'near', transactions },
  }
}

async function prepareClaim(request: ChainActionRequest, account: string): Promise<PreparedAction> {
  assertAccount(account)
  const token = exitToken(request)
  let lost: bigint
  let registered: boolean
  try {
    const [holdings, onToken] = await Promise.all([
      readHoldings(account),
      isRegistered(token.id, account),
    ])
    lost = amountIn(holdings.lost, token.id)
    registered = onToken
  } catch {
    throw cannotRead()
  }
  if (lost === BigInt(0)) {
    throw new ChainActionRefused(
      `Nothing in ${token.symbol} is waiting for you at Rhea DEX. Nothing was signed or sent.`
    )
  }
  const transactions: NearTransaction[] = [
    ...(registered ? [] : [{ receiverId: token.id, actions: [storageFor(account)] }]),
    {
      receiverId: RHEA_DEX,
      actions: [functionCall('claim_lostfound', { token_id: token.id }, RHEA_EXIT_GAS, '1')],
    },
    // This call always pays in wNEAR, so NEAR needs one more step to be NEAR.
    ...(token.id === WRAP_NEAR ? [unwrapTransaction(lost)] : []),
  ]
  const display = formatUnits(lost.toString(), token.decimals)
  return {
    venueId: RHEA_DEX_VENUE_ID,
    venueName: VENUE,
    kind: 'claim',
    summary: `Collect ${display} ${token.symbol} that Rhea DEX is holding under your name.`,
    pay: { amount: display, symbol: token.symbol },
    receive: { amount: display, symbol: token.symbol, approximate: false },
    notes: [
      'Rhea holds tokens here when a delivery to your wallet failed. This sends them to the account that signs, with no fee beyond network gas.',
      ...(registered ? [] : [`This also pays 0.00125 NEAR to register you on ${token.symbol}.`]),
    ],
    signing: { family: 'near', transactions },
  }
}

function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
  if (request.kind === 'withdraw') return prepareWithdraw(request, account)
  if (request.kind === 'claim') return prepareClaim(request, account)
  return prepareSwap(request, account)
}

function isRheaDexCall(receiver: string): boolean {
  return (
    receiver === RHEA_DEX ||
    receiver === WRAP_NEAR ||
    receiver === USDC_NEAR ||
    receiver === USDT_NEAR
  )
}

/** The token a swap message ends in, read from what actually ran. */
function tokenOutOf(msg: unknown): string | undefined {
  if (typeof msg !== 'string') return undefined
  try {
    const { actions } = JSON.parse(msg) as { actions?: { token_out?: unknown }[] }
    const out = actions?.[actions.length - 1]?.token_out
    return typeof out === 'string' ? out : undefined
  } catch {
    return undefined
  }
}

function symbolOf(tokenId: string | undefined): string {
  return nearTokens.find((t) => t.id === tokenId)?.symbol ?? 'your tokens'
}

const DEX_METHODS: ReadonlySet<string> = new Set([
  'ft_transfer_call',
  'withdraw',
  'claim_lostfound',
  'near_withdraw',
])

function notThisVenue(hash: string): SubmitResult {
  return {
    ok: false,
    pending: true,
    error: `Transaction ${hash} is not this account's on Rhea DEX. Check your wallet's activity.`,
  }
}

/**
 * Confirms what a wallet already sent. Every transaction must have run as this account on these
 * contracts. "Success" on a swap isn't enough: a refused swap also succeeds, by refunding, and a
 * delivery can fail after it. So this reads what the receipts did, and says where the money is.
 */
export async function confirmRheaDex(input: SubmitInput): Promise<SubmitResult> {
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
    if (outcome.signer !== account || !isRheaDexCall(outcome.receiver)) {
      return {
        ok: false,
        pending: true,
        error: `Transaction ${each} is not this account's on Rhea DEX. Check your wallet's activity.`,
      }
    }
    const registers = outcome.calls.every((c) => c.method === 'storage_deposit')
    if (outcome.state === 'failed') {
      // A failed registration moves nothing, and what comes after it speaks for itself.
      if (registers && each !== hash) continue
      if (moved || each !== hash) {
        return {
          ok: false,
          pending: true,
          error: `Part of this went through and part failed (${each}). Check your balances before trying again, and see ${explorerUrl(each)}.`,
        }
      }
      return {
        ok: false,
        error: `That failed on NEAR (${each}), so what you were sending stayed in your account, apart from the gas. You can try again.`,
      }
    }
    if (registers) continue
    if (!outcome.calls.some((c) => DEX_METHODS.has(c.method))) return notThisVenue(each)

    const swap = outcome.calls.find((c) => c.method === 'ft_transfer_call')
    if (swap !== undefined) {
      const tokenOut = tokenOutOf(swap.args['msg'])
      if (swap.args['receiver_id'] !== RHEA_DEX || tokenOut === undefined) {
        return {
          ok: false,
          pending: true,
          error: `Transaction ${each} is not this account's swap on Rhea DEX. Check your wallet's activity.`,
        }
      }
      const kept = amountKept(outcome.returned)
      if (kept === undefined) {
        return {
          ok: false,
          pending: true,
          error: `Your swap ran (${each}), but its result couldn't be read. Don't send it again. Check ${explorerUrl(each)}.`,
        }
      }
      if (kept === BigInt(0)) {
        const near = outcome.receiver === WRAP_NEAR
        return {
          ok: false,
          error: near
            ? `The price moved too far, so the swap stopped (${each}) and your NEAR came back as wNEAR in your wallet. Say "withdraw NEAR on Rhea DEX" to turn it back, or try the swap again.`
            : `The price moved too far, so the swap stopped (${each}) and your ${symbolOf(outcome.receiver)} came back to your wallet. You can try again.`,
        }
      }
      if (outcome.receipts.some((r) => r.failed && r.executor === tokenOut)) {
        const symbol = symbolOf(tokenOut)
        return {
          ok: false,
          pending: true,
          error: `The swap ran (${each}), but sending your ${symbol} to your wallet failed, so Rhea is holding it under your name. Say "withdraw ${symbol} on Rhea DEX" or "claim ${symbol} on Rhea DEX" to get it. Don't swap again for this.`,
        }
      }
      moved = true
      continue
    }

    const takesBack = outcome.calls.some(
      (c) => c.method === 'withdraw' || c.method === 'claim_lostfound'
    )
    if (takesBack && amountKept(outcome.returned) === BigInt(0)) {
      return {
        ok: false,
        ...(moved ? { pending: true } : {}),
        error: `The tokens couldn't reach your wallet (${each}), so they are still held under your name at Rhea. You can try again.`,
      }
    }
    moved = true
  }
  // Registering alone isn't what was asked, and a hash from elsewhere must not read as done.
  return moved ? { ok: true, hash, explorerUrl: explorerUrl(hash) } : notThisVenue(hash)
}

export const rheaDexVenue: ChainVenue = {
  id: RHEA_DEX_VENUE_ID,
  name: VENUE,
  kinds: ['swap', 'withdraw', 'claim'],
  quote: quoteSwap,
  prepare,
  positions,
  assertSafe: assertRheaDexSafe,
  submit: confirmRheaDex,
}
