import { CHAIN_DESCRIPTORS } from '@intent/config'

import { assertRestingPrice, LIMIT_NOT_HERE, limitPair } from './limit'
import { resolveRecipient, withResolvedName, type ResolvedName } from './names/resolve'
import { WRAP_NEAR } from './near/tokens'
import { fromBase, toBase } from './sequence'
import { holdingOf } from './sequence-flow'
import {
  ChainActionRefused,
  tokenBySymbol,
  type ChainActionKind,
  type ChainActionRequest,
  type ChainModule,
  type ChainToken,
  type ChainWithActions,
  type ChainVenue,
  type FollowOnStep,
  type PreparedAction,
  type VenuePosition,
  type WalletBalances,
  WHOLE_AMOUNT,
} from './types'

/** Keys only: each chain's name is its slug, and reading Stellar's descriptor at load would throw. */
const CHAIN_NAMES = new Set(Object.keys(CHAIN_DESCRIPTORS))

/**
 * The venue a request names, in lower case. "swap 10 USDC to MON on monad" reads "monad" as one,
 * but it only says where the person already is, so the chain they are on counts as none named.
 */
export function namedVenue(
  chainApi: Pick<ChainModule, 'chain'>,
  request: Pick<ChainActionRequest, 'venue'>
): string | undefined {
  const wanted = request.venue?.trim().toLowerCase()
  if (wanted === undefined) return undefined
  const { slug, name } = CHAIN_DESCRIPTORS[chainApi.chain]
  return wanted === slug || wanted === name.toLowerCase() ? undefined : wanted
}

/**
 * Whether a venue answers to that name. Another chain's name answers to nothing, so nothing runs
 * here that was asked for there, even where it is part of a venue's name, as NEAR is of 1Click's.
 */
export function venueAnswersTo(venue: Pick<ChainVenue, 'id' | 'name'>, wanted: string): boolean {
  if (CHAIN_NAMES.has(wanted)) return false
  return venue.id.toLowerCase() === wanted || venue.name.toLowerCase().includes(wanted)
}

/** The venue this chain goes to when none is named. */
function defaultVenueId(
  chainApi: ChainModule,
  kind: ChainActionKind,
  /** What the venue has to take or, for a swap, to deliver. */
  token: string
): string | undefined {
  return chainApi.venueForToken?.[kind]?.[token.trim().toUpperCase()] ?? chainApi.defaultVenue[kind]
}

function pickVenue(chainApi: ChainModule, request: ChainActionRequest): ChainVenue {
  const usable = chainApi.venues.filter((v) => v.kinds.includes(request.kind))
  const wanted = namedVenue(chainApi, request)
  if (wanted !== undefined) {
    const named = usable.find((v) => venueAnswersTo(v, wanted))
    if (named === undefined) {
      const names = usable.map((v) => v.name).join(', ')
      throw new ChainActionRefused(
        names === ''
          ? `Nothing here can ${request.kind} on this chain yet.`
          : `"${request.venue}" can't ${request.kind} here. Available: ${names}.`
      )
    }
    return named
  }
  const defaultId = defaultVenueId(
    chainApi,
    request.kind,
    request.kind === 'swap' ? (request.tokenOut ?? request.tokenIn) : request.tokenIn
  )
  const venue = usable.find((v) => v.id === defaultId) ?? usable[0]
  if (venue === undefined) {
    throw new ChainActionRefused(`Nothing here can ${request.kind} on this chain yet.`)
  }
  return venue
}

/**
 * Refuses a token this chain does not list as verified, in the same words
 * wherever it is asked: the signing route and the agent race both call this, so
 * a refused token reads the same in each and no agent is ever consulted about it.
 */
export function assertKnownTokens(chainApi: ChainModule, request: ChainActionRequest): ChainToken {
  const hintFor = (symbol: string | undefined): string => {
    const hint = chainApi.tokenHints?.[(symbol ?? '').trim().toUpperCase()]
    return hint === undefined ? '' : ` ${hint}`
  }
  const tokenIn = tokenBySymbol(chainApi.tokens, request.tokenIn)
  if (tokenIn === undefined) {
    throw new ChainActionRefused(
      `I can't confirm ${request.tokenIn} as a verified token on this chain, so I won't touch it.${hintFor(request.tokenIn)}`
    )
  }
  if (request.kind === 'swap' || request.kind === 'limit') {
    if (
      request.tokenOut === undefined ||
      tokenBySymbol(chainApi.tokens, request.tokenOut) === undefined
    ) {
      throw new ChainActionRefused(
        `I can't confirm ${request.tokenOut ?? 'that token'} as a verified token on this chain, so I won't trade it.${hintFor(request.tokenOut)}`
      )
    }
    if (request.tokenOut.toUpperCase() === request.tokenIn.toUpperCase()) {
      throw new ChainActionRefused('Those are the same token.')
    }
  }
  return tokenIn
}

const TAKES_WHOLE: ReadonlySet<ChainActionKind> = new Set([
  'withdraw',
  'unstake',
  'repay',
  'claim',
  'cancel',
])

/** Refuses an amount that is not a positive number, in the same words on every route. */
export function assertValidAmount(
  request: Pick<ChainActionRequest, 'amount'> & Partial<Pick<ChainActionRequest, 'kind'>>
): void {
  if (
    request.amount === WHOLE_AMOUNT &&
    request.kind !== undefined &&
    TAKES_WHOLE.has(request.kind)
  ) {
    return
  }
  const amount = Number(request.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ChainActionRefused(`"${request.amount}" is not an amount.`)
  }
}

const NAMES_SOMEONE: ReadonlySet<ChainActionKind> = new Set(['send', 'stream', 'invoice'])

/** The kinds that pay out of the wallet what they name, so the wallet must hold it. */
const SPENDS_FROM_WALLET: ReadonlySet<ChainActionKind> = new Set([
  'swap',
  'supply',
  'stake',
  'send',
  'repay',
  'stream',
  'pay_invoice',
  'limit',
])

/**
 * Only these name who they pay or bill, and each must. A person typed it, so it is checked here on
 * every chain, before anything is priced. A name is read here too, and what it reads to must pass
 * the same checks: from here on the action knows only that address.
 */
async function assertRecipientRule(
  chainApi: ChainModule,
  request: ChainActionRequest,
  tokenIn: ChainToken,
  account: string
): Promise<ResolvedName | undefined> {
  if (!NAMES_SOMEONE.has(request.kind)) {
    if (request.recipient !== undefined) {
      throw new ChainActionRefused(
        `A ${request.kind.replace('_', ' ')} doesn't take an address, so this was not built. Nothing was signed or sent.`
      )
    }
    return undefined
  }
  if (request.recipient === undefined) {
    throw new ChainActionRefused(
      `A ${request.kind} needs an address to go to. Nothing was signed or sent.`
    )
  }
  return resolveRecipient(chainApi.chain, tokenIn.symbol, request.recipient, account)
}

/**
 * Whether a step could run after a swap, asked while the swap is unsigned: what the chat alone
 * can't know, such as the venues this deployment offers and whether a receiver can take the token.
 * The amount isn't known yet, so the fee reserve is asked again at the step itself.
 */
export async function assertFollowOnCanRun(
  chainApi: ChainModule,
  step: FollowOnStep,
  account: string
): Promise<void> {
  const request: ChainActionRequest = { ...step, amount: '0' }
  assertKnownTokens(chainApi, request)
  await assertVenueCanFollow(pickVenue(chainApi, request), step, account)
  await assertFeesForBothSteps(chainApi, step, account)
}

async function assertVenueCanFollow(
  venue: ChainVenue,
  step: FollowOnStep,
  account: string
): Promise<void> {
  if (venue.assertCanFollow === undefined) {
    throw new ChainActionRefused(`${venue.name} can't follow a swap yet.`)
  }
  await venue.assertCanFollow(step, account)
}

/**
 * A step spending the native coin spends all that arrived, so what pays for the fees has to be there
 * already. Found out after the swap, it would strand the person halfway. Enough for two reserves,
 * since the swap's own fee comes out first. A failed read lets it through, as it does everywhere.
 */
async function assertFeesForBothSteps(
  chainApi: ChainModule,
  step: FollowOnStep,
  account: string
): Promise<void> {
  if (step.tokenIn.toUpperCase() !== NATIVE_SYMBOL[chainApi.chain]) return
  const reading = await readBalancesBriefly(chainApi, account)
  const native = reading?.tokens.find((t) => t.native)
  if (native === undefined) return
  const held = toBase(native.amount, native.decimals)
  const reserve = toBase(NATIVE_FEE_RESERVE[chainApi.chain], native.decimals)
  if (held === undefined || reserve === undefined) return
  const needed = reserve * BigInt(2)
  if (held >= needed) return
  throw new ChainActionRefused(
    `Keep at least ${fromBase(needed, native.decimals)} ${native.symbol} in your wallet before this, to pay the fees on both steps. You have ${native.amount}. Nothing was signed or sent.`
  )
}

/** How a follow-on will run, once a venue that takes the token has been found. */
export interface FollowOnPlan {
  kind: FollowOnStep['kind']
  /** The venue's name, so step 2 goes where step 1's card said it would. */
  venue?: string
  /** A token to swap into in place of the one asked for, because only that can be deposited. */
  tokenOut?: string
  /** What changed from what was asked, to say before anything is signed. */
  note?: string
}

/** Venues for this step, the one this chain would pick by default first. */
function venuesInOrder(
  chainApi: ChainModule,
  kind: ChainActionKind,
  tokenIn: string
): ChainVenue[] {
  const usable = chainApi.venues.filter((v) => v.kinds.includes(kind))
  const first = defaultVenueId(chainApi, kind, tokenIn)
  return [...usable.filter((v) => v.id === first), ...usable.filter((v) => v.id !== first)]
}

/** The first venue that says it could take this step, or the first refusal. Only a refusal is caught. */
async function firstTaking(
  chainApi: ChainModule,
  step: FollowOnStep,
  account: string
): Promise<{ venue: ChainVenue } | { refused: ChainActionRefused }> {
  let refused: ChainActionRefused | undefined
  for (const venue of venuesInOrder(chainApi, step.kind, step.tokenIn)) {
    try {
      await assertVenueCanFollow(venue, step, account)
      return { venue }
    } catch (e) {
      if (!(e instanceof ChainActionRefused)) throw e
      refused ??= e
    }
  }
  return {
    refused: refused ?? new ChainActionRefused(`Nothing here can ${step.kind} on this chain yet.`),
  }
}

/**
 * Where a step after a swap will go, asked before the swap is signed. A venue the person named is
 * theirs, and it says yes or no. Otherwise any venue on the chain may take it, not only the default.
 *
 * "Deposit" asks for the money to earn. So a token no lending venue can take after a swap is staked where it can be,
 * which keeps the token asked for, or else swapped into its wrapped form where that can be lent.
 * Each of those says so beside the steps before the first signature.
 */
export async function resolveFollowOn(
  chainApi: ChainModule,
  step: FollowOnStep,
  account: string
): Promise<FollowOnPlan> {
  if (step.kind === 'send' || namedVenue(chainApi, step) !== undefined) {
    await assertFollowOnCanRun(chainApi, step, account)
    return { kind: step.kind }
  }
  assertKnownTokens(chainApi, { ...step, amount: '0' })
  const asked = await firstTaking(chainApi, step, account)
  if ('venue' in asked) {
    await assertFeesForBothSteps(chainApi, step, account)
    return { kind: step.kind, venue: asked.venue.name }
  }
  if (step.kind !== 'supply') throw asked.refused

  const token = step.tokenIn.trim().toUpperCase()
  const stake = await firstTaking(chainApi, { ...step, kind: 'stake' }, account)
  if ('venue' in stake) {
    await assertFeesForBothSteps(chainApi, step, account)
    const { name } = stake.venue
    return {
      kind: 'stake',
      venue: name,
      note: `No lending app here can take ${token} straight after a swap, so step 2 stakes it on ${name}, which earns too.`,
    }
  }
  const wrapped = chainApi.wrappedToken?.[token]
  if (wrapped !== undefined) {
    const lent = await firstTaking(chainApi, { ...step, tokenIn: wrapped }, account)
    if ('venue' in lent) {
      const { name } = lent.venue
      return {
        kind: 'supply',
        venue: name,
        tokenOut: wrapped,
        note: `${name} takes ${wrapped} and not ${token}, so this swaps to ${wrapped}, the same coin in wrapped form, and deposits that.`,
      }
    }
    // The wrapped form was the only way, so why it can't go in is the answer.
    throw lent.refused
  }
  throw asked.refused
}

export { LIMIT_NOT_HERE }

/**
 * Refuses a limit order that cannot run here, before any venue is asked: no safe venue on the chain,
 * a pair with no stablecoin, no venue, no live market price, or a price that would fill at once.
 */
export async function assertLimitCanRun(
  chainApi: ChainModule,
  request: ChainActionRequest,
  account: string
): Promise<void> {
  const notHere = LIMIT_NOT_HERE[chainApi.chain]
  if (notHere !== undefined) throw new ChainActionRefused(notHere)
  const pair = limitPair(request.tokenIn, request.tokenOut ?? '')
  if (pair === undefined) {
    throw new ChainActionRefused(
      'Limit orders here need USDC or USDT on one side. Nothing was signed or sent.'
    )
  }
  pickVenue(chainApi, request)
  const base = tokenBySymbol(chainApi.tokens, pair.base)
  const market = base === undefined ? undefined : await chainApi.priceUsd(base)
  if (market === undefined || !Number.isFinite(market) || !(market > 0)) {
    throw new ChainActionRefused(
      `I have no live price for ${pair.base}, so I can't check that price. Nothing was signed or sent.`
    )
  }
  assertRestingPrice(request.limitPrice ?? '', market, pair.selling, pair.base)
  await assertHeldForLimit(chainApi, request, account)
}

/**
 * Refuses an order for more than the wallet holds of what it gives up, matched on the token's id,
 * before a venue can ask for any setup. NEAR's table entry is `wrap.near` and stands for the native
 * coin too, so a sale there counts both. A read that fails or runs late doesn't refuse.
 */
async function assertHeldForLimit(
  chainApi: ChainModule,
  request: ChainActionRequest,
  account: string
): Promise<void> {
  const tokenIn = tokenBySymbol(chainApi.tokens, request.tokenIn)
  if (tokenIn === undefined) return
  const reading = await readBalancesBriefly(chainApi, account)
  if (reading === undefined) return
  const amount = holdingOf(reading, tokenIn)
  if (amount === undefined) return
  const native =
    chainApi.chain === 'near' && tokenIn.id === WRAP_NEAR
      ? reading.tokens.find((t) => t.native)
      : undefined
  const token = toBase(amount, tokenIn.decimals)
  const coin = native === undefined ? BigInt(0) : toBase(native.amount, tokenIn.decimals)
  const asked = toBase(request.amount, tokenIn.decimals)
  if (token === undefined || coin === undefined || asked === undefined) return
  const held = token + coin
  if (asked <= held) return
  throw new ChainActionRefused(
    `You hold ${fromBase(held, tokenIn.decimals)} ${tokenIn.symbol}, and this order needs ${request.amount}. Nothing was signed or sent.`
  )
}

/**
 * Prepares an action, with the same order of checks as every other money route:
 * known tokens, a real amount, then the build, then a check of what the venue's
 * API returned before anyone is asked to sign it.
 */
export async function prepareChainAction(
  chainApi: ChainModule,
  typed: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  // A cancel names a stream, and the venue reads its token from the chain.
  if (typed.kind === 'cancel') {
    const venue = pickVenue(chainApi, typed)
    const prepared = await venue.prepare(typed, account)
    venue.assertSafe(prepared.signing, account, prepared.context)
    return prepared
  }

  const tokenIn = assertKnownTokens(chainApi, typed)
  const crossing = chainApi.crossChainSend
  if (
    typed.kind === 'send' &&
    typed.recipient !== undefined &&
    crossing?.reaches(typed.recipient)
  ) {
    assertValidAmount(typed)
    await assertHeldForSend(chainApi, typed, tokenIn, account)
    const prepared = await crossing.venue.prepare(typed, account)
    crossing.venue.assertSafe(prepared.signing, account, prepared.context)
    return prepared
  }
  const named = await assertRecipientRule(chainApi, typed, tokenIn, account)
  const asked = named === undefined ? typed : { ...typed, recipient: named.address }

  assertValidAmount(asked)
  const exit = SLOT_OF[asked.kind] !== undefined
  const exitVenue = exit ? await pickExitVenue(chainApi, asked, account) : undefined
  const request = exitVenue === undefined ? asked : await withWholeAmount(exitVenue, asked, account)
  if (request.kind === 'limit') await assertLimitCanRun(chainApi, request, account)

  await assertNativeReserve(chainApi, request, account)
  await assertHeldForSend(chainApi, request, tokenIn, account)

  const venue = exitVenue ?? pickVenue(chainApi, request)
  const prepared = await venue.prepare(request, account)
  venue.assertSafe(prepared.signing, account, prepared.context)
  return named === undefined ? prepared : withResolvedName(prepared, named)
}

/** A read of a position may not hold up an exit, and one that runs late counts as unread. */
const POSITION_READ_MS = 6000

const SLOT_OF: Partial<Record<ChainActionKind, VenuePosition['slot']>> = {
  withdraw: 'supplied',
  unstake: 'staked',
  repay: 'borrowed',
  claim: 'claimable',
}

/** This venue's positions, or nothing if it can't say. */
export async function readPositionsBriefly(
  venue: Pick<ChainVenue, 'positions'>,
  account: string
): Promise<VenuePosition[] | undefined> {
  if (venue.positions === undefined) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      venue.positions(account),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('position read timed out')), POSITION_READ_MS)
      }),
    ])
  } catch {
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** An exit already under way still belongs to the venue it started on, which can say how it stands. */
const ALSO_ROUTES_ON: Partial<Record<ChainActionKind, readonly VenuePosition['slot'][]>> = {
  unstake: ['claimable', 'cooling'],
  claim: ['cooling'],
}

function inSlot(
  positions: readonly VenuePosition[],
  request: ChainActionRequest,
  slot: VenuePosition['slot'] | undefined
): VenuePosition | undefined {
  const wanted = request.tokenIn.trim().toUpperCase()
  return positions.find(
    (p) => p.slot === slot && p.symbol.toUpperCase() === wanted && Number(p.amount) > 0
  )
}

/** The figure a position shows for this request, or nothing if it holds none. */
function heldFor(
  positions: readonly VenuePosition[],
  request: ChainActionRequest
): string | undefined {
  return inSlot(positions, request, SLOT_OF[request.kind])?.amount
}

/** Whether this request belongs at this venue, and the figure to tell the person it has. */
function routedFor(
  positions: readonly VenuePosition[],
  request: ChainActionRequest
): string | undefined {
  const also = ALSO_ROUTES_ON[request.kind] ?? []
  return (
    heldFor(positions, request) ??
    also.map((slot) => inSlot(positions, request, slot)?.amount).find((a) => a !== undefined)
  )
}

/**
 * Where an exit goes when no venue was named: wherever the money is. One venue holding it is that
 * venue, and two is the person's choice. If a venue couldn't be read the money may be there, so
 * this never says it is nowhere, and leaves it to the usual pick.
 */
async function pickExitVenue(
  chainApi: ChainModule,
  request: ChainActionRequest,
  account: string
): Promise<ChainVenue> {
  const usable = chainApi.venues.filter((v) => v.kinds.includes(request.kind))
  if (namedVenue(chainApi, request) !== undefined || usable.length < 2) {
    return pickVenue(chainApi, request)
  }
  const readings = await Promise.all(usable.map((v) => readPositionsBriefly(v, account)))
  const holding = usable
    .map((venue, i) => ({ venue, held: routedFor(readings[i] ?? [], request) }))
    .filter((entry) => entry.held !== undefined)

  if (holding.length === 1) return (holding[0] as { venue: ChainVenue }).venue
  const verb = request.kind.replace('_', ' ')
  if (holding.length > 1) {
    const where = holding.map(({ venue, held }) => `${held} on ${venue.name}`).join(' and ')
    const first = (holding[0] as { venue: ChainVenue }).venue.name
    const example =
      request.kind === 'claim'
        ? `claim my ${request.tokenIn} from ${first}`
        : `${verb} ${request.amount} ${request.tokenIn} from ${first}`
    throw new ChainActionRefused(
      `You have ${request.tokenIn} in more than one place: ${where}. Say which, like "${example}". Nothing was signed or sent.`
    )
  }
  if (readings.some((reading) => reading === undefined)) return pickVenue(chainApi, request)
  throw new ChainActionRefused(
    `I don't see any ${request.tokenIn} to ${verb} on ${usable.map((v) => v.name).join(', ')}. Nothing was signed or sent.`
  )
}

/** "All" as the figure read from the chain now, so the card shows a number the person can check. */
async function withWholeAmount(
  venue: ChainVenue,
  request: ChainActionRequest,
  account: string
): Promise<ChainActionRequest> {
  if (request.amount !== WHOLE_AMOUNT || SLOT_OF[request.kind] === undefined) return request
  if (request.kind === 'claim') return request
  const positions = await readPositionsBriefly(venue, account)
  if (positions === undefined) {
    throw new ChainActionRefused(
      `I couldn't read how much ${request.tokenIn} you have on ${venue.name} right now. Try again shortly, or say an amount. Nothing was signed or sent.`
    )
  }
  const held = heldFor(positions, request)
  if (held === undefined) {
    const ready = inSlot(positions, request, 'claimable')
    const cooling = inSlot(positions, request, 'cooling')
    const under = [
      ready === undefined
        ? undefined
        : `${ready.amount} ${ready.symbol} is ready, so say "claim my ${ready.symbol}".`,
      cooling === undefined
        ? undefined
        : `${cooling.amount} ${cooling.symbol} is on its way${
            cooling.readyInHours === undefined
              ? ''
              : `, ready in about ${Math.ceil(cooling.readyInHours)} hours`
          }.`,
    ].filter((line) => line !== undefined)
    throw new ChainActionRefused(
      [
        `You have no ${request.tokenIn} to ${request.kind} on ${venue.name}.`,
        ...under,
        'Nothing was signed or sent.',
      ].join(' ')
    )
  }
  return { ...request, amount: held, wholePosition: true }
}

/** Native coin kept back for network fees, in display units: a trade may not spend into it. */
export const NATIVE_FEE_RESERVE: Record<ChainWithActions, string> = {
  solana: '0.005',
  sui: '0.05',
  near: '0.05',
  avalanche: '0.01',
  monad: '0.05',
}

const NATIVE_SYMBOL: Record<ChainWithActions, string> = {
  solana: 'SOL',
  sui: 'SUI',
  near: 'NEAR',
  avalanche: 'AVAX',
  monad: 'MON',
}

/** The balance read may wait on the chain's own deadline, which is far longer than a trade should. */
const RESERVE_READ_MS = 3000

/**
 * The wallet's balances, or nothing if the read fails or runs late. What this guards is a doomed
 * transaction, and it must never be what blocks a good one.
 */
async function readBalancesBriefly(
  chainApi: ChainModule,
  account: string
): Promise<WalletBalances | undefined> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      chainApi.balances(account, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('balance read timed out'))
        }, RESERVE_READ_MS)
      }),
    ])
  } catch {
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Refuses a send of more than the wallet is known to hold, matched on the token's id. A send a
 * wallet signs and the chain then fails costs the fee, and on NEAR reads as maybe having gone out.
 * The native coin is left to `assertNativeReserve`, which has already read it.
 */
async function assertHeldForSend(
  chainApi: ChainModule,
  request: ChainActionRequest,
  tokenIn: ChainToken,
  account: string
): Promise<void> {
  if (request.kind !== 'send' && request.kind !== 'stream' && request.kind !== 'pay_invoice') return
  if (tokenIn.symbol.toUpperCase() === NATIVE_SYMBOL[chainApi.chain]) return
  const reading = await readBalancesBriefly(chainApi, account)
  if (reading === undefined) return
  const amount = holdingOf(reading, tokenIn)
  if (amount === undefined) return
  const held = toBase(amount, tokenIn.decimals)
  const asked = toBase(request.amount, tokenIn.decimals)
  if (held === undefined || asked === undefined || asked <= held) return
  throw new ChainActionRefused(
    `You hold ${amount} ${tokenIn.symbol}, which is less than ${request.amount}. Nothing was signed or sent.`
  )
}

async function limitCostOf(
  chainApi: ChainModule,
  request: ChainActionRequest,
  account: string
): Promise<ChainVenue['limitCost']> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const venue = pickVenue(chainApi, request)
    if (venue.limitCostNow === undefined) return venue.limitCost
    return await Promise.race([
      venue.limitCostNow(request, account),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), RESERVE_READ_MS)
      }),
    ])
  } catch {
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Refuses spending a wallet's whole native balance, which would leave nothing for the fee.
 * Reads the balance once and compares in base units. A read that fails or runs late passes:
 * this guards a doomed trade, and must never be what blocks a good one.
 *
 * The native token is the one the reading marks native; the request counts as spending it when
 * the module's own table entry for the symbol has that id. NEAR is held natively as "near" but its
 * table names the wrapped form `wrap.near`, so there that table entry stands for the native coin.
 */
export async function assertNativeReserve(
  chainApi: ChainModule,
  request: ChainActionRequest,
  account: string
): Promise<void> {
  // Taking out of a position or borrowing adds to the wallet, so there is no fee money to protect.
  if (!SPENDS_FROM_WALLET.has(request.kind)) return
  const tokenIn = tokenBySymbol(chainApi.tokens, request.tokenIn)
  if (tokenIn === undefined) return
  const cost = request.kind === 'limit' ? await limitCostOf(chainApi, request, account) : undefined
  const costed = cost !== undefined && cost.symbol.toUpperCase() === NATIVE_SYMBOL[chainApi.chain]
  const sellsNative = tokenIn.symbol.toUpperCase() === NATIVE_SYMBOL[chainApi.chain]
  if (!sellsNative && !costed) return

  const reading = await readBalancesBriefly(chainApi, account)
  if (reading === undefined) return

  const native = reading.tokens.find((t) => t.native)
  if (native === undefined) return
  const isNative =
    tokenIn.id === native.id || (chainApi.chain === 'near' && tokenIn.id === WRAP_NEAR)
  const spends = sellsNative && isNative
  if (!spends && !costed) return

  const held = toBase(native.amount, native.decimals)
  const reserve = toBase(NATIVE_FEE_RESERVE[chainApi.chain], native.decimals)
  const asked = spends ? toBase(request.amount, native.decimals) : BigInt(0)
  if (held === undefined || reserve === undefined || asked === undefined) return

  let kept = reserve
  let keepText = `${NATIVE_FEE_RESERVE[chainApi.chain]} ${native.symbol} for network fees`
  if (costed) {
    const costBase = toBase(cost.amount, native.decimals)
    if (costBase !== undefined) {
      kept = reserve + costBase
      keepText = `${fromBase(kept, native.decimals)} ${native.symbol} for network fees and the ${cost.amount} ${cost.symbol} this order costs to set up`
    }
  }
  if (asked <= held - kept) return

  const spendable = held > kept ? held - kept : BigInt(0)
  throw new ChainActionRefused(
    `Keep about ${keepText}. ` +
      (spends
        ? `You can spend up to ${fromBase(spendable, native.decimals)} ${native.symbol} here. `
        : `You hold ${native.amount} ${native.symbol}. `) +
      'Nothing was signed or sent.'
  )
}
