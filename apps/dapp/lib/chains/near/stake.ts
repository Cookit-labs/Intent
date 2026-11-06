import {
  ChainActionRefused,
  toBaseUnits,
  tokenBySymbol,
  type ChainActionRequest,
  type ChainVenue,
  type NearTransaction,
  type PreparedAction,
  type SubmitInput,
  type SubmitResult,
  type VenuePosition,
  type VenueQuote,
  type FollowOnStep,
} from '../types'
import { NEAR_ACCOUNT, NEAR_TX_HASH } from './account'
import { accountBalance, isRegistered, viewCall, waitForTransaction } from './rpc'
import {
  assertMetapoolSafe,
  assertRnearSafe,
  METAPOOL_EXIT_GAS,
  METAPOOL_STAKE_GAS,
  RNEAR_EXIT_GAS,
  RNEAR_STAKE_GAS,
  STORAGE_DEPOSIT_YOCTO,
  STORAGE_GAS,
} from './safety'
import {
  explorerUrl,
  formatUnits,
  METAPOOL_CONTRACT,
  nearTokens,
  RNEAR_CONTRACT,
  WRAP_NEAR,
  YOCTO_PER_NEAR,
} from './tokens'

export const RNEAR_VENUE_ID = 'rnear'
export const METAPOOL_VENUE_ID = 'metapool'

const RHEA_APY_URL = 'https://api.rhea.finance/get-rnear-apy'
const APY_TIMEOUT_MS = 5_000
const CONFIRM_WAIT_MS = 25_000
/** 43,200 blocks at about 0.6 seconds each, as `rnear-sdk` counts them. */
const HOURS_PER_EPOCH = 7.2
/** Share rounding leaves dust in `unstaked`. `rnear-sdk` treats less than this as nothing pending. */
const MIN_PENDING_YOCTO = BigInt('10000000000000000000')
/** rNEAR's contract keeps this much for itself and won't pay out of it. */
const RNEAR_MIN_RESERVE_YOCTO = YOCTO_PER_NEAR

/**
 * A swap to NEAR can arrive as NEAR or as wNEAR, and only the wrapped form can be measured by its
 * token, while a stake spends the native coin. So a stake can't be shown to spend what arrived.
 */
async function refuseStakeAfterSwap(_step: FollowOnStep): Promise<void> {
  throw new ChainActionRefused(
    "A swap to NEAR can arrive as NEAR or wNEAR, so a stake can't follow it here. Swap first, then stake what arrives. Nothing was signed or sent."
  )
}

function cannotRead(venue: string): ChainActionRefused {
  return new ChainActionRefused(
    `${venue} could not be read from NEAR just now, so nothing was built. Try again in a minute.`
  )
}

/** Yocto of NEAR staked, read as an amount of the staking token at the contract's price. */
function receiptAmount(stakedYocto: string, pricePerToken: string): string {
  const price = BigInt(pricePerToken)
  if (price <= BigInt(0)) throw new Error('no price')
  return formatUnits(((BigInt(stakedYocto) * YOCTO_PER_NEAR) / price).toString(), 24)
}

/** Only ever a rate from Rhea's own endpoint. Without one, the card simply shows no rate. */
async function rnearApyPercent(): Promise<number | undefined> {
  try {
    const response = await fetch(RHEA_APY_URL, { signal: AbortSignal.timeout(APY_TIMEOUT_MS) })
    if (!response.ok) return undefined
    const { data } = (await response.json()) as { data?: unknown }
    const percent = Number(data)
    return typeof data === 'string' && Number.isFinite(percent) && percent > 0 && percent < 100
      ? percent
      : undefined
  } catch {
    return undefined
  }
}

function assertStakeRequest(request: ChainActionRequest, account: string, venue: string): void {
  if (!NEAR_ACCOUNT.test(account)) {
    throw new ChainActionRefused('That is not a NEAR account. Connect a NEAR wallet and try again.')
  }
  const token = tokenBySymbol(nearTokens, request.tokenIn)
  if (request.kind !== 'stake' || token?.id !== WRAP_NEAR) {
    throw new ChainActionRefused(`${venue} only stakes NEAR. Swap to NEAR first, then stake it.`)
  }
}

function stakeCall(amount: string, gas: bigint): NearTransaction['actions'][number] {
  return {
    type: 'FunctionCall',
    params: { methodName: 'deposit_and_stake', args: {}, gas: gas.toString(), deposit: amount },
  }
}

/**
 * What a stake would give back, without building the transaction. A rate Rhea does not
 * give is left out rather than guessed. Meta Pool has no rate endpoint here, so its quote
 * carries none.
 */
async function quoteRnear(request: ChainActionRequest, account: string): Promise<VenueQuote> {
  assertStakeRequest(request, account, 'rNEAR')
  const amount = toBaseUnits(request.amount, 24)
  let receive: string
  try {
    receive = receiptAmount(amount, await viewCall<string>(RNEAR_CONTRACT, 'ft_price'))
  } catch {
    throw cannotRead('rNEAR')
  }
  const apyPercent = await rnearApyPercent()
  return {
    receive: { amount: receive, symbol: 'rNEAR' },
    ...(apyPercent !== undefined ? { apyPercent } : {}),
  }
}

async function quoteMetapool(request: ChainActionRequest, account: string): Promise<VenueQuote> {
  assertStakeRequest(request, account, 'Meta Pool')
  const amount = toBaseUnits(request.amount, 24)
  try {
    const price = await viewCall<string>(METAPOOL_CONTRACT, 'get_st_near_price')
    return { receive: { amount: receiptAmount(amount, price), symbol: 'stNEAR' } }
  } catch {
    throw cannotRead('Meta Pool')
  }
}

async function prepareRnear(request: ChainActionRequest, account: string): Promise<PreparedAction> {
  const venue = 'rNEAR'
  assertStakeRequest(request, account, venue)
  const amount = toBaseUnits(request.amount, 24)

  let price: string
  let registered: boolean
  let paused: boolean
  try {
    ;[price, registered, paused] = await Promise.all([
      viewCall<string>(RNEAR_CONTRACT, 'ft_price'),
      isRegistered(RNEAR_CONTRACT, account),
      viewCall<boolean>(RNEAR_CONTRACT, 'is_paused'),
    ])
    receiptAmount(amount, price)
  } catch {
    throw cannotRead(venue)
  }
  if (paused) {
    throw new ChainActionRefused('rNEAR staking is paused right now. Nothing was signed or sent.')
  }
  const apy = await rnearApyPercent()

  const actions: NearTransaction['actions'] = []
  if (!registered) {
    actions.push({
      type: 'FunctionCall',
      params: {
        methodName: 'storage_deposit',
        args: { account_id: account, registration_only: true },
        gas: STORAGE_GAS.toString(),
        deposit: STORAGE_DEPOSIT_YOCTO,
      },
    })
  }
  actions.push(stakeCall(amount, RNEAR_STAKE_GAS))

  return {
    venueId: RNEAR_VENUE_ID,
    venueName: venue,
    kind: 'stake',
    summary: `Stake ${request.amount} NEAR with Rhea and receive rNEAR.`,
    pay: { amount: request.amount, symbol: 'NEAR' },
    receive: { amount: receiptAmount(amount, price), symbol: 'rNEAR', approximate: true },
    ...(apy !== undefined ? { apy: { basePercent: apy } } : {}),
    notes: [
      "rNEAR's price rises only as staking rewards come in, and the rate changes, so no return is guaranteed. Leaving takes about 30 hours at full price, or happens right away through a swap at the market price.",
      'Most rNEAR sits in Rhea Lend, which lost about $18.4M to an exploit in April 2026. Trouble there could hurt the price of rNEAR and the instant way out.',
      ...(registered
        ? []
        : ['This first stake also pays 0.00125 NEAR to register you on the rNEAR token.']),
    ],
    signing: { family: 'near', transactions: [{ receiverId: RNEAR_CONTRACT, actions }] },
  }
}

async function prepareMetapool(
  request: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  const venue = 'Meta Pool'
  assertStakeRequest(request, account, venue)
  const amount = toBaseUnits(request.amount, 24)

  let price: string
  let minimum: string
  try {
    const [stPrice, params] = await Promise.all([
      viewCall<string>(METAPOOL_CONTRACT, 'get_st_near_price'),
      viewCall<{ min_deposit_amount: string }>(METAPOOL_CONTRACT, 'get_contract_params'),
    ])
    price = stPrice
    minimum = params.min_deposit_amount
    receiptAmount(amount, price)
    BigInt(minimum)
  } catch {
    throw cannotRead(venue)
  }
  if (BigInt(amount) < BigInt(minimum)) {
    throw new ChainActionRefused(
      `Meta Pool takes at least ${formatUnits(minimum, 24)} NEAR. Try a larger amount. Nothing was signed or sent.`
    )
  }

  return {
    venueId: METAPOOL_VENUE_ID,
    venueName: venue,
    kind: 'stake',
    summary: `Stake ${request.amount} NEAR with Meta Pool and receive stNEAR.`,
    pay: { amount: request.amount, symbol: 'NEAR' },
    receive: { amount: receiptAmount(amount, price), symbol: 'stNEAR', approximate: true },
    notes: [
      "stNEAR's price rises only as staking rewards come in, and the rate changes, so no return is guaranteed.",
      'Leaving takes about 4 epochs, around 30 hours at the current pace, or happens right away through its liquidity pool at a discount of 0.3% to 5%.',
      'Your NEAR is held by a smart contract that delegates to many validators, so a contract bug or validator failure could cost you.',
    ],
    signing: {
      family: 'near',
      transactions: [
        { receiverId: METAPOOL_CONTRACT, actions: [stakeCall(amount, METAPOOL_STAKE_GAS)] },
      ],
    },
  }
}

/** What an account has at a stake venue, in base units. */
interface StakeHolding {
  receipt: bigint
  /** NEAR already unstaked and not yet collected. */
  pending: bigint
  /** The contract would pay `pending` now, which takes more than the wait having ended. */
  ready: boolean
  epochsLeft?: number | undefined
}

interface ExitVenue {
  id: string
  name: string
  receipt: string
  contract: string
  gas: bigint
  claimMethod: string
  price: () => Promise<string>
  /** Throws when it can't read. */
  read: (account: string) => Promise<StakeHolding>
  /** Refuses while the contract can't take an exit at all. */
  assertOpen: () => Promise<void>
  unstakeNotes: (nearOut: string) => Promise<string[]>
}

const RESTART_NOTE =
  'Unstaking again before you collect restarts the wait for everything still waiting, because the contract keeps one clock per account. Claim first if any of it is ready.'

async function readMetapool(account: string): Promise<StakeHolding> {
  const info = await viewCall<{
    st_near: string
    unstaked: string
    can_withdraw: boolean
    unstake_full_epochs_wait_left: number
  }>(METAPOOL_CONTRACT, 'get_account_info', { account_id: account })
  const pending = BigInt(info.unstaked)
  let ready = info.can_withdraw && pending >= MIN_PENDING_YOCTO
  if (ready) {
    // The wait can end before the contract has pulled the money back from its validators.
    const state = await viewCall<{ retrieved_for_unstake_claims: string }>(
      METAPOOL_CONTRACT,
      'get_contract_state'
    )
    ready = BigInt(state.retrieved_for_unstake_claims) >= pending
  }
  return {
    receipt: BigInt(info.st_near),
    pending,
    ready,
    epochsLeft: info.unstake_full_epochs_wait_left,
  }
}

/** rNEAR has no view of the epoch, and rpc.ts offers only contract views, so Meta Pool's is read. */
async function currentEpoch(): Promise<number | undefined> {
  try {
    const state = await viewCall<{ env_epoch_height: string }>(
      METAPOOL_CONTRACT,
      'get_contract_state'
    )
    const epoch = Number(state.env_epoch_height)
    return Number.isSafeInteger(epoch) ? epoch : undefined
  } catch {
    return undefined
  }
}

async function readRnear(account: string): Promise<StakeHolding> {
  const [details, receipt] = await Promise.all([
    viewCall<{
      unstaked_balance: string
      unstaked_available_epoch_height: number
      can_withdraw: boolean
    }>(RNEAR_CONTRACT, 'get_account_details', { account_id: account }),
    viewCall<string>(RNEAR_CONTRACT, 'ft_balance_of', { account_id: account }),
  ])
  const pending = BigInt(details.unstaked_balance)
  const waiting = pending >= MIN_PENDING_YOCTO
  let ready = waiting && details.can_withdraw
  if (ready) {
    // `assert_can_withdraw` also needs this much free on the contract, its reserve aside.
    const held = BigInt(await accountBalance(RNEAR_CONTRACT))
    ready = held - RNEAR_MIN_RESERVE_YOCTO >= pending
  }
  let epochsLeft: number | undefined
  if (waiting && !details.can_withdraw) {
    const epoch = await currentEpoch()
    epochsLeft = epoch === undefined ? undefined : details.unstaked_available_epoch_height - epoch
  }
  return { receipt: BigInt(receipt), pending, ready, epochsLeft }
}

function hoursFor(epochsLeft: number | undefined): number | undefined {
  return epochsLeft === undefined || epochsLeft <= 0
    ? undefined
    : Math.ceil(epochsLeft * HOURS_PER_EPOCH)
}

const METAPOOL_EXIT: ExitVenue = {
  id: METAPOOL_VENUE_ID,
  name: 'Meta Pool',
  receipt: 'stNEAR',
  contract: METAPOOL_CONTRACT,
  gas: METAPOOL_EXIT_GAS,
  claimMethod: 'withdraw_unstaked',
  price: () => viewCall<string>(METAPOOL_CONTRACT, 'get_st_near_price'),
  read: readMetapool,
  assertOpen: async () => undefined,
  unstakeNotes: async (nearOut) => {
    const epochs = await viewCall<number>(METAPOOL_CONTRACT, 'compute_current_unstaking_delay', {
      amount: nearOut,
    })
    return [
      `Your stNEAR is gone as soon as this is signed, and your NEAR comes in a second step. Meta Pool says the wait is ${epochs} epochs right now, about ${Math.ceil(epochs * HOURS_PER_EPOCH)} hours. After that, say "claim my NEAR". It earns nothing while it waits.`,
      "Even after the wait, Meta Pool's operator has to bring the money back from its validators, so a claim can be refused for a little longer.",
      RESTART_NOTE,
    ]
  },
}

const RNEAR_EXIT: ExitVenue = {
  id: RNEAR_VENUE_ID,
  name: 'rNEAR',
  receipt: 'rNEAR',
  contract: RNEAR_CONTRACT,
  gas: RNEAR_EXIT_GAS,
  claimMethod: 'withdraw_all',
  price: () => viewCall<string>(RNEAR_CONTRACT, 'ft_price'),
  read: readRnear,
  assertOpen: async () => {
    if (await viewCall<boolean>(RNEAR_CONTRACT, 'is_paused')) {
      throw new ChainActionRefused(
        'rNEAR exits are paused right now, by the contract itself. Nothing was signed or sent.'
      )
    }
  },
  unstakeNotes: async () => [
    'Your rNEAR is gone as soon as this is signed, and your NEAR comes in a second step. The wait is at least 4 epochs, about 30 hours, and runs longer when its validators are already busy. After that, say "claim my NEAR". It earns nothing while it waits.',
    RESTART_NOTE,
    "The source link rNEAR's contract publishes does not open. Its methods were checked against what the deployed contract reports about itself and an older public copy of the source.",
  ],
}

function stakePositions(venue: ExitVenue): (account: string) => Promise<VenuePosition[]> {
  return async (account) => {
    if (!NEAR_ACCOUNT.test(account)) throw new Error('not a NEAR account')
    const { receipt, pending, ready, epochsLeft } = await venue.read(account)
    const positions: VenuePosition[] = []
    if (receipt > BigInt(0)) {
      positions.push({
        slot: 'staked',
        symbol: venue.receipt,
        amount: formatUnits(receipt.toString(), 24),
      })
    }
    if (pending >= MIN_PENDING_YOCTO) {
      const amount = formatUnits(pending.toString(), 24)
      positions.push(
        ready
          ? { slot: 'claimable', symbol: 'NEAR', amount }
          : { slot: 'cooling', symbol: 'NEAR', amount, readyInHours: hoursFor(epochsLeft) }
      )
    }
    return positions
  }
}

async function readForExit(venue: ExitVenue, account: string): Promise<StakeHolding> {
  if (!NEAR_ACCOUNT.test(account)) {
    throw new ChainActionRefused('That is not a NEAR account. Connect a NEAR wallet and try again.')
  }
  try {
    await venue.assertOpen()
    return await venue.read(account)
  } catch (error) {
    throw error instanceof ChainActionRefused ? error : cannotRead(venue.name)
  }
}

async function prepareUnstake(
  venue: ExitVenue,
  request: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  if (request.tokenIn.trim().toUpperCase() !== venue.receipt.toUpperCase()) {
    throw new ChainActionRefused(
      `${venue.name} takes back the ${venue.receipt} you hold, so say it in ${venue.receipt}, like "unstake 1 ${venue.receipt}". Nothing was signed or sent.`
    )
  }
  const { receipt: held } = await readForExit(venue, account)
  if (held <= BigInt(0)) {
    throw new ChainActionRefused(`You hold no ${venue.receipt}. Nothing was signed or sent.`)
  }
  const whole = request.wholePosition === true
  const asked = whole ? held : BigInt(toBaseUnits(request.amount, 24))
  if (asked > held) {
    throw new ChainActionRefused(
      `You hold ${formatUnits(held.toString(), 24)} ${venue.receipt}, which is less than ${request.amount}. Nothing was signed or sent.`
    )
  }

  let nearOut: bigint
  let notes: string[]
  try {
    nearOut = (asked * BigInt(await venue.price())) / YOCTO_PER_NEAR
    notes = await venue.unstakeNotes(nearOut.toString())
  } catch {
    throw cannotRead(venue.name)
  }
  if (nearOut <= BigInt(0)) {
    throw new ChainActionRefused('That amount is too small to unstake. Nothing was signed or sent.')
  }

  // Each contract takes a part in NEAR. All of it is a call of its own, so no dust is left behind.
  const gas = venue.gas.toString()
  const action: NearTransaction['actions'][number] = {
    type: 'FunctionCall',
    params: whole
      ? { methodName: 'unstake_all', args: {}, gas, deposit: '0' }
      : { methodName: 'unstake', args: { amount: nearOut.toString() }, gas, deposit: '0' },
  }
  const display = formatUnits(asked.toString(), 24)
  return {
    venueId: venue.id,
    venueName: venue.name,
    kind: 'unstake',
    summary: `Unstake ${display} ${venue.receipt} from ${venue.name}, and collect the NEAR once its wait is over.`,
    pay: { amount: display, symbol: venue.receipt },
    receive: { amount: formatUnits(nearOut.toString(), 24), symbol: 'NEAR', approximate: true },
    notes,
    signing: { family: 'near', transactions: [{ receiverId: venue.contract, actions: [action] }] },
  }
}

async function prepareClaim(
  venue: ExitVenue,
  request: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  const asked = request.tokenIn.trim().toUpperCase()
  if (asked !== 'NEAR' && asked !== venue.receipt.toUpperCase()) {
    throw new ChainActionRefused(
      `${venue.name} pays out NEAR, not ${request.tokenIn}. Nothing was signed or sent.`
    )
  }
  const { pending, ready, epochsLeft } = await readForExit(venue, account)
  if (pending < MIN_PENDING_YOCTO) {
    throw new ChainActionRefused(
      `You have nothing unstaked waiting at ${venue.name}. Nothing was signed or sent.`
    )
  }
  const amount = formatUnits(pending.toString(), 24)
  if (!ready) {
    const hours = hoursFor(epochsLeft)
    throw new ChainActionRefused(
      hours !== undefined
        ? `Your ${amount} NEAR at ${venue.name} isn't ready yet. It should be in about ${hours} hours. Nothing was signed or sent.`
        : `Your ${amount} NEAR at ${venue.name} isn't ready yet, because the contract is still bringing it back from its validators. Try again in a few hours. Nothing was signed or sent.`
    )
  }
  return {
    venueId: venue.id,
    venueName: venue.name,
    kind: 'claim',
    summary: `Collect ${amount} NEAR from ${venue.name} into your wallet.`,
    pay: { amount, symbol: 'NEAR' },
    receive: { amount, symbol: 'NEAR', approximate: false },
    notes: ['This collects everything that is ready. You pay only the network fee.'],
    signing: {
      family: 'near',
      transactions: [
        {
          receiverId: venue.contract,
          actions: [
            {
              type: 'FunctionCall',
              params: {
                methodName: venue.claimMethod,
                args: {},
                gas: venue.gas.toString(),
                deposit: '0',
              },
            },
          ],
        },
      ],
    },
  }
}

function prepareFor(venue: ExitVenue, stake: ChainVenue['prepare']): ChainVenue['prepare'] {
  return (request, account) => {
    if (request.kind === 'unstake') return prepareUnstake(venue, request, account)
    if (request.kind === 'claim') return prepareClaim(venue, request, account)
    return stake(request, account)
  }
}

export const rnearVenue: ChainVenue = {
  id: RNEAR_VENUE_ID,
  name: 'rNEAR',
  kinds: ['stake', 'unstake', 'claim'],
  assertCanFollow: refuseStakeAfterSwap,
  quote: quoteRnear,
  prepare: prepareFor(RNEAR_EXIT, prepareRnear),
  positions: stakePositions(RNEAR_EXIT),
  assertSafe: assertRnearSafe,
}

export const metapoolVenue: ChainVenue = {
  id: METAPOOL_VENUE_ID,
  name: 'Meta Pool',
  kinds: ['stake', 'unstake', 'claim'],
  assertCanFollow: refuseStakeAfterSwap,
  quote: quoteMetapool,
  prepare: prepareFor(METAPOOL_EXIT, prepareMetapool),
  positions: stakePositions(METAPOOL_EXIT),
  assertSafe: assertMetapoolSafe,
}

const STAKE_CONTRACTS: Record<string, { contract: string; methods: readonly string[] }> = {
  [RNEAR_VENUE_ID]: {
    contract: RNEAR_CONTRACT,
    methods: ['deposit_and_stake', 'unstake', 'unstake_all', 'withdraw_all'],
  },
  [METAPOOL_VENUE_ID]: {
    contract: METAPOOL_CONTRACT,
    methods: ['deposit_and_stake', 'unstake', 'unstake_all', 'withdraw_unstaked'],
  },
}

/** What failed, and where the money is now. A failed call on NEAR costs only the gas. */
function failureOf(calls: { method: string }[], hash: string): string {
  if (calls.some((c) => c.method === 'unstake' || c.method === 'unstake_all')) {
    return `The unstake failed on NEAR (${hash}), so you still hold what you tried to unstake, apart from the gas. You can try again.`
  }
  if (calls.some((c) => c.method === 'withdraw_all' || c.method === 'withdraw_unstaked')) {
    return `The claim failed on NEAR (${hash}), so your NEAR is still waiting at the venue, apart from the gas. You can try again.`
  }
  return `The stake failed on NEAR (${hash}), so your NEAR came back to your account, apart from the gas. You can try again.`
}

/**
 * Confirms what a NEAR wallet already sent. Used for the staking venues. Each
 * transaction must have run as this account against this venue's contract, so a
 * hash from somewhere else can't be reported as one of its actions.
 */
export async function confirmStake(input: SubmitInput): Promise<SubmitResult> {
  const { account, venueId, signed } = input
  if (signed.family !== 'near') return { ok: false, error: 'That is not a NEAR transaction.' }
  const venue = Object.prototype.hasOwnProperty.call(STAKE_CONTRACTS, venueId)
    ? STAKE_CONTRACTS[venueId]
    : undefined
  // The wallet has already sent, so nothing here proves that nothing moved.
  if (venue === undefined) {
    return { ok: false, pending: true, error: 'Nothing to confirm for that venue.' }
  }

  const hash = signed.hashes[signed.hashes.length - 1]
  if (hash === undefined || signed.hashes.some((h) => !NEAR_TX_HASH.test(h))) {
    return {
      ok: false,
      pending: true,
      error: 'The wallet did not return a transaction hash to follow.',
    }
  }

  const giveUpAt = Date.now() + CONFIRM_WAIT_MS
  for (const each of signed.hashes) {
    const outcome = await waitForTransaction(each, account, Math.max(giveUpAt - Date.now(), 1))
    if (outcome.state === 'unknown') {
      return {
        ok: false,
        pending: true,
        error: `Your transaction was sent (${each}) but hasn't been confirmed yet. Don't send it again. Check ${explorerUrl(each)} in a minute.`,
      }
    }
    if (outcome.state === 'failed') {
      return { ok: false, error: failureOf(outcome.calls, each) }
    }
    const expected = outcome.calls.some((c) => venue.methods.includes(c.method))
    if (outcome.signer !== account || outcome.receiver !== venue.contract || !expected) {
      return {
        ok: false,
        pending: true,
        error: `Transaction ${each} is not this account's action with this venue. Check your wallet's activity.`,
      }
    }
  }
  return { ok: true, hash, explorerUrl: explorerUrl(hash) }
}
