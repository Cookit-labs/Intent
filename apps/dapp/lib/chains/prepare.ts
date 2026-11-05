import { CHAIN_DESCRIPTORS } from '@intent/config'

import { assertWithinCap, tradeCapUsd, TradeCapExceeded } from '../server/trade-cap'
import { assertRestingPrice, LIMIT_NOT_HERE, limitPair } from './limit'
import { WRAP_NEAR } from './near/tokens'
import { sendRefusal } from './recipient'
import { fromBase, toBase } from './sequence'
import { holdingOf } from './sequence-flow'
import {
  ChainActionRefused,
  tokenBySymbol,
  type ChainActionRequest,
  type ChainModule,
  type ChainToken,
  type ChainWithActions,
  type ChainVenue,
  type FollowOnStep,
  type PreparedAction,
  type WalletBalances,
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
  const defaultId = chainApi.defaultVenue[request.kind]
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

/**
 * Refuses an amount that is not a positive number, a token with no live price,
 * and a trade over the dollar cap. Shared with the agent race so a refused
 * amount is refused in the same words before any agent or venue is called.
 *
 * The cap always reads as mainnet, because these chains only run on mainnet. The
 * Stellar network a deployment defaults to says nothing about Solana's funds.
 */
export async function assertAmountWithinCap(
  chainApi: ChainModule,
  request: ChainActionRequest,
  tokenIn: ChainToken,
  env: Record<string, string | undefined> = process.env
): Promise<void> {
  const price = await chainApi.priceUsd(tokenIn)
  const amount = Number(request.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ChainActionRefused(`"${request.amount}" is not an amount.`)
  }
  // The cap's own wording is for whoever runs the deployment, so a person gets this instead.
  const usd = price === undefined ? Number.NaN : amount * price
  const noun = request.kind === 'send' ? 'transfer' : 'trade'
  try {
    assertWithinCap(usd, env, 'mainnet')
  } catch (e) {
    if (!(e instanceof TradeCapExceeded)) throw e
    throw new ChainActionRefused(
      Number.isFinite(usd)
        ? `This app caps each ${noun} at ${tradeCapUsd(env, 'mainnet')}, and this one is about ${usd.toFixed(2)}. Try a smaller amount.`
        : `This ${noun} could not be valued in dollars right now, so it was not built. Try again shortly.`
    )
  }
}

/** A send names who it pays and nothing else does. Refused before anything is priced or read. */
function assertRecipientRule(
  chainApi: ChainModule,
  request: ChainActionRequest,
  tokenIn: ChainToken,
  account: string
): void {
  if (request.kind !== 'send') {
    if (request.recipient !== undefined) {
      throw new ChainActionRefused(
        'Only a send takes an address, so this was not built. Nothing was signed or sent.'
      )
    }
    return
  }
  if (request.recipient === undefined) {
    throw new ChainActionRefused('A send needs an address to go to. Nothing was signed or sent.')
  }
  const refusal = sendRefusal(chainApi.chain, tokenIn.symbol, request.recipient, account)
  if (refusal !== undefined) throw new ChainActionRefused(refusal)
}

/**
 * Whether a step could run after a swap, asked while the swap is unsigned: what the chat alone
 * can't know, such as the venues this deployment offers and whether a receiver can take the token.
 * The amount isn't known yet, so the dollar cap and the reserve are asked again at the step itself.
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
 * known tokens, a dollar value under the cap, then the build, then a check of
 * what the venue's API returned before anyone is asked to sign it.
 *
 * The cap always reads as mainnet, because these chains only run on mainnet. The
 * Stellar network a deployment defaults to says nothing about Solana's funds.
 */
export async function prepareChainAction(
  chainApi: ChainModule,
  request: ChainActionRequest,
  account: string,
  env: Record<string, string | undefined> = process.env
): Promise<PreparedAction> {
  const tokenIn = assertKnownTokens(chainApi, request)
  assertRecipientRule(chainApi, request, tokenIn, account)
  if (request.kind === 'limit') await assertLimitCanRun(chainApi, request, account)

  await assertAmountWithinCap(chainApi, request, tokenIn, env)
  await assertNativeReserve(chainApi, request, account)
  await assertHeldForSend(chainApi, request, tokenIn, account)

  const venue = pickVenue(chainApi, request)
  const prepared = await venue.prepare(request, account)
  venue.assertSafe(prepared.signing, account, prepared.context)
  return prepared
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
  if (request.kind !== 'send') return
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
