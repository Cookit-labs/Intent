import { CHAIN_DESCRIPTORS } from '@intent/config'

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
  const defaultId =
    chainApi.venueForToken?.[request.kind]?.[request.tokenIn.trim().toUpperCase()] ??
    chainApi.defaultVenue[request.kind]
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
  if (request.kind === 'swap') {
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
  const venue = pickVenue(chainApi, request)
  if (venue.assertCanFollow === undefined) {
    throw new ChainActionRefused(`${venue.name} can't follow a swap yet.`)
  }
  await venue.assertCanFollow(step, account)
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
  const named = await assertRecipientRule(chainApi, typed, tokenIn, account)
  const asked = named === undefined ? typed : { ...typed, recipient: named.address }

  assertValidAmount(asked)
  const exit = SLOT_OF[asked.kind] !== undefined
  const exitVenue = exit ? await pickExitVenue(chainApi, asked, account) : undefined
  const request = exitVenue === undefined ? asked : await withWholeAmount(exitVenue, asked, account)

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
  if (tokenIn.symbol.toUpperCase() !== NATIVE_SYMBOL[chainApi.chain]) return

  const reading = await readBalancesBriefly(chainApi, account)
  if (reading === undefined) return

  const native = reading.tokens.find((t) => t.native)
  if (native === undefined) return
  const isNative =
    tokenIn.id === native.id || (chainApi.chain === 'near' && tokenIn.id === WRAP_NEAR)
  if (!isNative) return

  const held = toBase(native.amount, native.decimals)
  const reserve = toBase(NATIVE_FEE_RESERVE[chainApi.chain], native.decimals)
  const asked = toBase(request.amount, native.decimals)
  if (held === undefined || reserve === undefined || asked === undefined) return
  if (asked <= held - reserve) return

  const spendable = held > reserve ? held - reserve : BigInt(0)
  throw new ChainActionRefused(
    `Keep about ${NATIVE_FEE_RESERVE[chainApi.chain]} ${native.symbol} for network fees. ` +
      `You can spend up to ${fromBase(spendable, native.decimals)} ${native.symbol} here. ` +
      'Nothing was signed or sent.'
  )
}
