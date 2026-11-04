import { CHAIN_DESCRIPTORS } from '@intent/config'

import { assertWithinCap, tradeCapUsd, TradeCapExceeded } from '../server/trade-cap'
import { WRAP_NEAR } from './near/tokens'
import { fromBase, toBase } from './sequence'
import {
  ChainActionRefused,
  tokenBySymbol,
  type ChainActionRequest,
  type ChainModule,
  type ChainToken,
  type ChainWithActions,
  type ChainVenue,
  type PreparedAction,
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
  try {
    assertWithinCap(usd, env, 'mainnet')
  } catch (e) {
    if (!(e instanceof TradeCapExceeded)) throw e
    throw new ChainActionRefused(
      Number.isFinite(usd)
        ? `This app caps each trade at ${tradeCapUsd(env, 'mainnet')}, and this one is about ${usd.toFixed(2)}. Try a smaller amount.`
        : 'This trade could not be valued in dollars right now, so it was not built. Try again shortly.'
    )
  }
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

  await assertAmountWithinCap(chainApi, request, tokenIn, env)
  await assertNativeReserve(chainApi, request, account)

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
  if (tokenIn.symbol.toUpperCase() !== NATIVE_SYMBOL[chainApi.chain]) return

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let reading
  try {
    reading = await Promise.race([
      chainApi.balances(account, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('balance read timed out'))
        }, RESERVE_READ_MS)
      }),
    ])
  } catch {
    return
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }

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
