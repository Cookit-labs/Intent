import { NextResponse } from 'next/server'

import { buildSwapTransaction } from '../../../../lib/swap/build-tx'
import type { SwapQuote } from '../../../../lib/swap/quote'
import { createHorizonQuoter } from '../../../../lib/swap/sources/horizon-quoter'
import { createSoroswapQuoter } from '../../../../lib/swap/sources/soroswap-quoter'
import { buildSorobanSwap, prepareSorobanSwap } from '../../../../lib/swap/build-soroban'
import { builderFor, type VenueKind } from '../../../../lib/swap/venue-routing'
import { applySlippage } from '../../../../lib/swap/assets'
import { DEFAULT_SLIPPAGE_BPS } from '../../../../lib/swap/build-tx'

/**
 * Builds the transaction a user is about to sign.
 *
 * Server-side because @stellar/stellar-sdk is multi-megabyte and the client
 * does not otherwise need it — quoting and balance reads are deliberately plain
 * REST for the same reason.
 *
 * The route re-quotes before building rather than trusting the quote it is
 * handed. A price the user reviewed a minute ago may no longer fill, and the
 * client is not a trustworthy source for the numbers that end up in a signed
 * transaction.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * How old a submitted quote may be before it is refused outright.
 *
 * Generous, because this is not the staleness guard it looks like: the route
 * re-prices from Horizon below and builds against that fresh quote, so the
 * submitted one only says which pair and size the user agreed to. The real
 * protection against a moved price is `destMin` on the operation, which the
 * network enforces.
 *
 * At two minutes it was rejecting legitimate signatures. A competition takes
 * 25-65 seconds, and the quote is timestamped before the agents start — so
 * reading four proposals and picking one routinely pushed a genuine attempt
 * past the limit, which surfaced as an unexplained 409.
 */
const MAX_QUOTE_AGE_MS = 900_000

export async function POST(request: Request): Promise<NextResponse> {
  let body: { account?: unknown; quote?: unknown; slippageBps?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  if (typeof body.account !== 'string' || body.account === '') {
    return NextResponse.json({ error: 'account is required' }, { status: 400 })
  }
  if (typeof body.quote !== 'object' || body.quote === null) {
    return NextResponse.json({ error: 'quote is required' }, { status: 400 })
  }

  const submitted = body.quote as SwapQuote
  const age = Date.now() - new Date(submitted.quotedAt).getTime()
  if (Number.isNaN(age) || age > MAX_QUOTE_AGE_MS) {
    return NextResponse.json({ error: 'quote_expired' }, { status: 409 })
  }

  // Which builder signs this decides everything below, and it is decided by
  // the venue the agent chose rather than assumed. Hardcoding Horizon here is
  // why a Soroswap route could never be signed however good its price.
  let venue: VenueKind
  try {
    venue = builderFor(submitted)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'unsupported venue' },
      { status: 400 }
    )
  }

  if (venue === 'soroban') {
    return await buildViaSoroban(body.account, submitted)
  }

  // Re-price from the source of truth. The client's numbers are treated as a
  // statement of intent, not as the amounts to sign.
  const fresh = await createHorizonQuoter().quote(
    submitted.kind === 'strict_receive'
      ? {
          kind: 'strict_receive',
          from: submitted.from,
          to: submitted.to,
          receiveAmount: submitted.destAmount,
        }
      : {
          kind: 'strict_send',
          from: submitted.from,
          to: submitted.to,
          sendAmount: submitted.sendAmount,
        }
  )

  if (!fresh.ok) {
    return NextResponse.json({ error: 'no_route', reason: fresh.failure.reason }, { status: 200 })
  }

  try {
    const built = await buildSwapTransaction({
      account: body.account,
      quote: fresh.quote,
      ...(typeof body.slippageBps === 'number' ? { slippageBps: body.slippageBps } : {}),
    })

    return NextResponse.json({
      xdr: built.xdr,
      destMin: built.destMin,
      sendAmount: built.sendAmount,
      slippageBps: built.slippageBps,
      // Returned so the UI can show what actually changed between review and
      // signing rather than silently swapping the numbers underneath.
      quote: fresh.quote,
    })
  } catch (e) {
    // buildSwapTransaction refuses anything that is not a self-swap; that
    // refusal is a safety property, not an ordinary failure, so it surfaces
    // rather than being flattened into a generic error.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'could not build the transaction' },
      { status: 400 }
    )
  }
}

/**
 * Builds a Soroswap swap and prepares it for signature.
 *
 * Two things differ from the classic path. The router enforces the floor
 * on-chain rather than this app checking it, so `minReceive` is the real
 * protection and is derived from the quote rather than trusted from the
 * client. And a Soroban transaction cannot be signed straight from the
 * builder: the network computes a resource footprint during simulation, and
 * an unprepared envelope is rejected at submission with an opaque error.
 *
 * Simulation is also the last honest check that the swap will succeed. If the
 * route has moved past the floor, it fails here — before a wallet prompt —
 * rather than on-chain after one.
 */
async function buildViaSoroban(account: string, submitted: SwapQuote): Promise<NextResponse> {
  // Re-quoted rather than taken from the client, for the same reason the
  // classic path re-prices: the submitted numbers state intent, not amounts.
  const fresh = await createSoroswapQuoter().quote({
    kind: 'strict_send',
    from: submitted.from,
    to: submitted.to,
    sendAmount: submitted.sendAmount,
  })

  if (!fresh.ok) {
    return NextResponse.json({ error: 'no_route', reason: fresh.failure.reason }, { status: 200 })
  }

  const minReceive = applySlippage(fresh.quote.destAmount, DEFAULT_SLIPPAGE_BPS)

  let built
  try {
    built = await buildSorobanSwap({
      account,
      from: fresh.quote.from,
      to: fresh.quote.to,
      sendAmount: fresh.quote.sendAmount,
      minReceive,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'could not build the transaction' },
      { status: 400 }
    )
  }

  const prepared = await prepareSorobanSwap(built.xdr)
  if (!prepared.ok) {
    // The router's own revert reason, which distinguishes "the price moved"
    // from "no pool exists" — far more useful than a generic failure.
    return NextResponse.json(
      { error: 'simulation_failed', reason: prepared.reason },
      { status: 409 }
    )
  }

  return NextResponse.json({
    xdr: prepared.xdr,
    destMin: minReceive,
    sendAmount: built.sendAmount,
    slippageBps: DEFAULT_SLIPPAGE_BPS,
    quote: fresh.quote,
  })
}
