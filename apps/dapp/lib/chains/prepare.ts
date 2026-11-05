import { assertWithinCap, tradeCapUsd, TradeCapExceeded } from '../server/trade-cap'
import {
  ChainActionRefused,
  tokenBySymbol,
  type ChainActionRequest,
  type ChainModule,
  type ChainVenue,
  type PreparedAction,
} from './types'

function pickVenue(chainApi: ChainModule, request: ChainActionRequest): ChainVenue {
  const usable = chainApi.venues.filter((v) => v.kinds.includes(request.kind))
  if (request.venue !== undefined) {
    const wanted = request.venue.trim().toLowerCase()
    const named = usable.find(
      (v) => v.id.toLowerCase() === wanted || v.name.toLowerCase().includes(wanted)
    )
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
  const tokenIn = tokenBySymbol(chainApi.tokens, request.tokenIn)
  if (tokenIn === undefined) {
    throw new ChainActionRefused(
      `I can't confirm ${request.tokenIn} as a verified token on this chain, so I won't touch it.`
    )
  }
  if (request.kind === 'swap') {
    if (
      request.tokenOut === undefined ||
      tokenBySymbol(chainApi.tokens, request.tokenOut) === undefined
    ) {
      throw new ChainActionRefused(
        `I can't confirm ${request.tokenOut ?? 'that token'} as a verified token on this chain, so I won't trade it.`
      )
    }
    if (request.tokenOut.toUpperCase() === request.tokenIn.toUpperCase()) {
      throw new ChainActionRefused('Those are the same token.')
    }
  }

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

  const venue = pickVenue(chainApi, request)
  const prepared = await venue.prepare(request, account)
  venue.assertSafe(prepared.signing, account)
  return prepared
}
