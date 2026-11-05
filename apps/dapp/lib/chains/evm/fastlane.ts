import { encodeFunctionData, isAddress, parseAbi, zeroAddress, type Address, type Hash } from 'viem'

import { formatUnits, toDisplayNumber } from '../near/tokens'
import {
  ChainActionRefused,
  takesOnly,
  toBaseUnits,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
  type SubmitInput,
  type SubmitResult,
  type VenuePosition,
  type VenueQuote,
} from '../types'
import {
  assertEvmCallSafe,
  buildEvmCall,
  confirmEvmCall,
  type CheckContext,
  type DecodedCall,
  type EvmCallPolicy,
  type EvmReaderClient,
} from './call'
import { evmClient, evmReader, type EvmClient } from './client'
import { sameAddress } from './submit'
import { EVM_CHAINS } from './tokens'

/**
 * Liquid staking of MON with FastLane's shMON. A stake is `deposit`, paid in MON. An unstake is
 * the atomic exit through FastLane's pool, which pays out in the same transaction.
 *
 * The free queue is left out: `requestUnstake` needs a later `completeUnstake`, and this app has
 * no step to come back and claim with, so someone could be left holding an unfinished exit.
 */

const VENUE_NAME = 'FastLane'
const DECIMALS = 18

// https://shmonad-user-docs.pages.dev/addresses. A proxy. Its implementation is an exact match on
// Sourcify, chain 143, 0x8Ee4FF5FF50198dcbB7B882A0781F42724Dd095f, and the live test pins it.
export const SHMON = '0x1B68626dCa36c7fE922fD2d55E4f631d962dE19c'

export const FASTLANE_TOKENS: ChainToken[] = [
  { symbol: 'shMON', id: SHMON, decimals: DECIMALS, name: 'ShMonad' },
]

// src/shmonad/FLERC4626.sol in the verified source. `deposit` reverts unless msg.value == assets.
const SHMON_ABI = parseAbi([
  'function deposit(uint256 assets, address receiver) payable returns (uint256)',
  'function redeemWithSlippageProtection(uint256 shares, address receiver, address owner, uint256 minAssetsOut) returns (uint256)',
  'function previewDeposit(uint256 assets) view returns (uint256)',
  'function previewRedeemDetailed(uint256 shares) view returns (uint256 grossAssets, uint256 feeAssets, uint256 netAssets)',
  'function previewUnstake(uint256 shares) view returns (uint256)',
  'function maxRedeem(address owner) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
])

/** The exit's fee can rise with the pool's use before it lands, so this bounds what that may cost. */
const MIN_OUT_PERCENT = BigInt(99)

const ZERO = BigInt(0)

const QUEUE_NOTE =
  'FastLane also has a queue with no fee, which takes about 4 to 5 epochs, roughly a day, or 2 more when redemptions are heavy. This app does not offer it yet. It is requestUnstake and then completeUnstake on the shMON contract.'

const ADMIN_NOTE =
  'Your MON sits in contracts that can fail. A 5 of 7 multisig can upgrade them after a 3-day wait. With no wait, it can change fees, including the instant exit’s, and close new deposits and the queue.'

const AUDIT_NOTE =
  'FastLane has published audits of versions 1.0 and 1.1. The contract running now is newer, and I found no published audit of this version.'

function refuse(reason: string): never {
  throw new ChainActionRefused(`${reason} Nothing was signed or sent.`)
}

function checkCall(call: DecodedCall, { account, value }: CheckContext): void {
  if (call.functionName === 'deposit') {
    const [assets, receiver] = call.args as [bigint, string]
    if (!sameAddress(receiver, account)) refuse('This stake credits the shMON to someone else.')
    if (assets === ZERO || value !== assets) {
      refuse('This stake pays a different amount of MON than it names.')
    }
    return
  }
  const [shares, receiver, owner, minAssetsOut] = call.args as [bigint, string, string, bigint]
  if (!sameAddress(owner, account)) refuse('This unstakes shMON that belongs to someone else.')
  if (!sameAddress(receiver, account)) refuse('This unstake pays the MON to someone else.')
  if (value !== ZERO) refuse('An unstake does not spend MON as value.')
  if (shares === ZERO || minAssetsOut === ZERO) {
    refuse('This unstake has no amount or no minimum to receive.')
  }
}

// No spender and nothing approvable: the person pays in MON, and burns their own shMON.
export const FASTLANE_POLICY: EvmCallPolicy = {
  venueName: VENUE_NAME,
  chain: 'monad',
  contracts: {
    [SHMON]: {
      abi: SHMON_ABI,
      functions: ['deposit', 'redeemWithSlippageProtection'],
      check: checkCall,
    },
  },
  spenders: [],
  approvable: [],
  mayPayNative: true,
}

function assertAccount(account: string): void {
  if (!isAddress(account, { strict: false }) || sameAddress(account, zeroAddress)) {
    refuse('That is not a Monad account.')
  }
}

function unitsOf(amount: string): bigint {
  try {
    return BigInt(toBaseUnits(amount, DECIMALS))
  } catch (e) {
    return refuse(e instanceof Error ? e.message : 'That is not an amount.')
  }
}

function display(units: bigint): string {
  return formatUnits(units.toString(), DECIMALS)
}

/** The wording is written for a swap, and the rest of it holds for a stake. */
function reserveNote(held: bigint, units: bigint): string[] {
  const { spendReserve } = EVM_CHAINS.monad
  return spendReserve !== undefined && held - units < BigInt(spendReserve.units)
    ? [spendReserve.note.replace('this swap', 'this stake')]
    : []
}

/**
 * Dollars per shMON, for ranking routes, from the MON price and what the contract says a shMON is
 * worth before the exit fee. 1Click lists no shMON, so nothing else can value it. Any doubt is no
 * price.
 */
export async function shmonPriceUsd(
  monUsd: number | undefined,
  reader: EvmReaderClient = evmReader('monad')
): Promise<number | undefined> {
  if (monUsd === undefined) return undefined
  try {
    const mon = await reader.readContract({
      address: SHMON,
      abi: SHMON_ABI,
      functionName: 'previewUnstake',
      args: [BigInt(10) ** BigInt(DECIMALS)],
    })
    return toDisplayNumber(mon.toString(), DECIMALS) * monUsd
  } catch {
    return undefined
  }
}

export function createFastlaneVenue(
  reader: EvmReaderClient = evmReader('monad'),
  client: EvmClient = evmClient('monad')
): ChainVenue {
  const { gasReserve, spendReserve } = EVM_CHAINS.monad
  const reserve = BigInt(gasReserve)
  const kept = `${formatUnits(gasReserve, DECIMALS)} MON`

  async function readStake(request: ChainActionRequest, account: string) {
    if (request.kind !== 'stake') refuse(`${VENUE_NAME} cannot ${request.kind} here.`)
    assertAccount(account)
    if (request.tokenIn.trim().toUpperCase() !== 'MON') {
      refuse(`${VENUE_NAME} stakes MON, not ${request.tokenIn}. Try "stake 1 MON with FastLane".`)
    }
    const units = unitsOf(request.amount)
    let shares: bigint
    try {
      shares = await reader.readContract({
        address: SHMON,
        abi: SHMON_ABI,
        functionName: 'previewDeposit',
        args: [units],
      })
    } catch {
      return refuse(`I could not read from ${VENUE_NAME} what this stake would return.`)
    }
    if (shares === ZERO) refuse('This stake is too small to return any shMON.')
    return { units, shares }
  }

  /** No apyPercent: no rate can be read from the contract, and a rate is never invented. */
  async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
    const { shares } = await readStake(request, account)
    return { receive: { amount: display(shares), symbol: 'shMON' } }
  }

  async function prepareStake(
    request: ChainActionRequest,
    account: string
  ): Promise<PreparedAction> {
    const { units, shares } = await readStake(request, account)
    let held: bigint
    try {
      held = await reader.getBalance({ address: account as Address })
    } catch {
      return refuse('I could not read this account’s MON balance from Monad.')
    }
    if (held < units + reserve) {
      refuse(
        `This account needs ${request.amount} MON for the stake and about ${kept} more for the network fee, and holds less than that.`
      )
    }
    const { signing } = await buildEvmCall(
      {
        chain: 'monad',
        account,
        to: SHMON,
        data: encodeFunctionData({
          abi: SHMON_ABI,
          functionName: 'deposit',
          args: [units, account as Address],
        }),
        value: units,
      },
      reader
    )
    const receive = display(shares)
    return {
      venueId: 'fastlane',
      venueName: VENUE_NAME,
      kind: 'stake',
      summary: `Stake ${request.amount} MON with ${VENUE_NAME} for about ${receive} shMON.`,
      pay: { amount: request.amount, symbol: 'MON' },
      receive: { amount: receive, symbol: 'shMON', approximate: true },
      notes: [
        ...reserveNote(held, units),
        'Staking rewards are not guaranteed, and I am not showing a rate because I could not read one from the contract. FastLane’s docs put its cut at 5% of staking rewards and 50% of other rewards.',
        'shMON grows in value against MON, so you get fewer shMON than the MON you put in.',
        `To get out, unstake here. That is instant through FastLane’s pool, for a fee of 0.005% to 1.005% depending on how much of the pool is in use, and it only works up to what the pool holds. ${QUEUE_NOTE}`,
        ADMIN_NOTE,
        AUDIT_NOTE,
      ],
      signing,
    }
  }

  async function prepareUnstake(
    request: ChainActionRequest,
    account: string
  ): Promise<PreparedAction> {
    assertAccount(account)
    if (request.tokenIn.trim().toUpperCase() !== 'SHMON') {
      refuse(
        `${VENUE_NAME} unstakes shMON, not ${request.tokenIn}. Try "unstake 1 shMON from FastLane".`
      )
    }
    const asked = unitsOf(request.amount)
    const whole = request.wholePosition === true
    const owner = account as Address
    let shares = asked
    let holding: bigint
    let redeemable: bigint
    let fee: bigint
    let net: bigint
    let held: bigint
    try {
      const balance = await reader.readContract({
        address: SHMON,
        abi: SHMON_ABI,
        functionName: 'balanceOf',
        args: [owner],
      })
      // shMON doesn't grow in number, so all of it is what the wallet holds now.
      if (whole && balance > ZERO) shares = balance
      const [max, preview, coin] = await Promise.all([
        reader.readContract({
          address: SHMON,
          abi: SHMON_ABI,
          functionName: 'maxRedeem',
          args: [owner],
        }),
        reader.readContract({
          address: SHMON,
          abi: SHMON_ABI,
          functionName: 'previewRedeemDetailed',
          args: [shares],
        }),
        reader.getBalance({ address: owner }),
      ])
      holding = balance
      redeemable = max
      fee = preview[1]
      net = preview[2]
      held = coin
    } catch {
      return refuse(`I could not read from ${VENUE_NAME} what this unstake would return.`)
    }
    if (whole && holding === ZERO) refuse('You hold no shMON to unstake.')
    if (holding < shares) {
      refuse(`You hold ${display(holding)} shMON, which is less than ${request.amount}.`)
    }
    if (shares > redeemable) {
      refuse(
        `${VENUE_NAME}’s instant pool can only cover about ${display(redeemable)} of your shMON right now. Try a smaller amount. ${QUEUE_NOTE}`
      )
    }
    if (net === ZERO) refuse('This unstake is too small to return any MON.')
    if (held < reserve) {
      refuse(`This account has too little MON for the network fee. Keep about ${kept}.`)
    }
    const minOut = (net * MIN_OUT_PERCENT) / BigInt(100)
    if (minOut === ZERO) refuse('This unstake is too small to protect with a minimum.')
    const { signing } = await buildEvmCall(
      {
        chain: 'monad',
        account,
        to: SHMON,
        data: encodeFunctionData({
          abi: SHMON_ABI,
          functionName: 'redeemWithSlippageProtection',
          args: [shares, owner, owner, minOut],
        }),
      },
      reader
    )
    const receive = display(net)
    const shown = whole ? display(shares) : request.amount
    return {
      venueId: 'fastlane',
      venueName: VENUE_NAME,
      kind: 'unstake',
      summary: `Unstake ${whole ? `all of your shMON, ${shown},` : `${shown} shMON`} from ${VENUE_NAME} for about ${receive} MON, straight away.`,
      pay: { amount: shown, symbol: 'shMON' },
      receive: { amount: receive, symbol: 'MON', approximate: true },
      notes: [
        `This is the instant exit through FastLane’s pool. Its fee right now is about ${display(fee)} MON, already taken off what you receive, and goes to the remaining shMON holders. The rate runs from 0.005% to 1.005% depending on how much of the pool is in use.`,
        `If the fee rises before this lands and you would get under ${display(minOut)} MON, the transaction fails and your shMON stays put. Only the gas is spent.`,
        QUEUE_NOTE,
        ADMIN_NOTE,
        AUDIT_NOTE,
      ],
      signing,
    }
  }

  /** shMON in the wallet, in shMON, since that is what an unstake takes. A failed read throws. */
  async function positions(account: string): Promise<VenuePosition[]> {
    assertAccount(account)
    const shares = await reader.readContract({
      address: SHMON,
      abi: SHMON_ABI,
      functionName: 'balanceOf',
      args: [account as Address],
    })
    return shares === ZERO ? [] : [{ slot: 'staked', symbol: 'shMON', amount: display(shares) }]
  }

  return {
    id: 'fastlane',
    name: VENUE_NAME,
    kinds: ['stake', 'unstake'],
    positions,
    assertCanFollow: async (step, account) => {
      if (step.kind !== 'stake') refuse(`${VENUE_NAME} can only stake after a swap.`)
      await takesOnly(VENUE_NAME, ['MON'])(step, account)
    },
    quote,
    prepare: (request, account) =>
      request.kind === 'unstake'
        ? prepareUnstake(request, account)
        : prepareStake(request, account),
    assertSafe: (payload, account) => assertEvmCallSafe(payload, account, FASTLANE_POLICY),
    /** A reverted stake spent MON, so Monad's reserve is the likely cause. An unstake spends none. */
    submit: async (input: SubmitInput): Promise<SubmitResult> => {
      const result = await confirmEvmCall(FASTLANE_POLICY, input.account, input.signed, client)
      if (result.ok || result.pending === true) return result
      if (spendReserve === undefined || input.signed.family !== 'evm') return result
      try {
        const { value } = await client.transaction(input.signed.hash as Hash)
        return value > ZERO
          ? { ...result, error: `${result.error} ${spendReserve.reverted}` }
          : result
      } catch {
        return result
      }
    },
  }
}
