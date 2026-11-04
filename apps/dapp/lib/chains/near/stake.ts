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
  type VenueQuote,
} from '../types'
import { NEAR_ACCOUNT, NEAR_TX_HASH } from './account'
import { isRegistered, viewCall, waitForTransaction } from './rpc'
import {
  assertMetapoolSafe,
  assertRnearSafe,
  METAPOOL_STAKE_GAS,
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

export const rnearVenue: ChainVenue = {
  id: RNEAR_VENUE_ID,
  name: 'rNEAR',
  kinds: ['stake'],
  quote: quoteRnear,
  prepare: prepareRnear,
  assertSafe: assertRnearSafe,
}

export const metapoolVenue: ChainVenue = {
  id: METAPOOL_VENUE_ID,
  name: 'Meta Pool',
  kinds: ['stake'],
  quote: quoteMetapool,
  prepare: prepareMetapool,
  assertSafe: assertMetapoolSafe,
}

const STAKE_CONTRACTS: Record<string, string> = {
  [RNEAR_VENUE_ID]: RNEAR_CONTRACT,
  [METAPOOL_VENUE_ID]: METAPOOL_CONTRACT,
}

/**
 * Confirms what a NEAR wallet already sent. Used for the staking venues. Each
 * transaction must have run as this account against this venue's contract, so a
 * hash from somewhere else can't be reported as a stake.
 */
export async function confirmStake(input: SubmitInput): Promise<SubmitResult> {
  const { account, venueId, signed } = input
  if (signed.family !== 'near') return { ok: false, error: 'That is not a NEAR transaction.' }
  const contract = Object.prototype.hasOwnProperty.call(STAKE_CONTRACTS, venueId)
    ? STAKE_CONTRACTS[venueId]
    : undefined
  if (contract === undefined) return { ok: false, error: 'Nothing to confirm for that venue.' }

  const hash = signed.hashes[signed.hashes.length - 1]
  if (hash === undefined || signed.hashes.some((h) => !NEAR_TX_HASH.test(h))) {
    return { ok: false, error: 'The wallet did not return a transaction hash to follow.' }
  }

  const giveUpAt = Date.now() + CONFIRM_WAIT_MS
  for (const each of signed.hashes) {
    const outcome = await waitForTransaction(each, account, Math.max(giveUpAt - Date.now(), 1))
    if (outcome.state === 'unknown') {
      return {
        ok: false,
        error: `Your transaction was sent (${each}) but hasn't been confirmed yet. Don't send it again. Check ${explorerUrl(each)} in a minute.`,
      }
    }
    if (outcome.state === 'failed') {
      return {
        ok: false,
        error: `The stake failed on NEAR (${each}), so your NEAR came back to your account, apart from the gas. You can try again.`,
      }
    }
    const stakes = outcome.calls.some((c) => c.method === 'deposit_and_stake')
    if (outcome.signer !== account || outcome.receiver !== contract || !stakes) {
      return {
        ok: false,
        error: `Transaction ${each} is not this account's stake with this venue. Check your wallet's activity.`,
      }
    }
  }
  return { ok: true, hash, explorerUrl: explorerUrl(hash) }
}
