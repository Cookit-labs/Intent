import { stellarTestnet } from '@intent/config'
import { NextResponse } from 'next/server'

import { sacFor } from '../../../../lib/swap/build-soroban'
import { feePaidBy } from '../../../../lib/sponsor/sponsor'
import { derivePreview, simulatedPreview } from '../../../../lib/swap/preview'

import { buildSwapTransaction } from '../../../../lib/swap/build-tx'
import type { SwapQuote } from '../../../../lib/swap/quote'
import { createHorizonQuoter } from '../../../../lib/swap/sources/horizon-quoter'
import { createSoroswapQuoter } from '../../../../lib/swap/sources/soroswap-quoter'
import { createAquariusQuoter } from '../../../../lib/swap/sources/aquarius-quoter'
import { buildAquariusSwap } from '../../../../lib/swap/build-aquarius'
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
  if (venue === 'aquarius') {
    return await buildViaAquarius(body.account, submitted)
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
      // Read from the operations, not from the quote: the floor the network
      // will enforce is what the user is actually promised.
      preview: {
        ...derivePreview(built.xdr, body.account, stellarTestnet.networkPassphrase),
        feePaidBy: feePaidBy(),
      },
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
    // The network's own simulation of this call, read for the signer's two
    // token balances. Neither figure is the agent's or the quoter's.
    preview: {
      ...simulatedPreview(
        prepared.sim,
        account,
        [
          { code: fresh.quote.from.code, contract: sacFor(fresh.quote.from) },
          { code: fresh.quote.to.code, contract: sacFor(fresh.quote.to) },
        ],
        prepared.feeXlm
      ),
      feePaidBy: feePaidBy(),
    },
    destMin: minReceive,
    sendAmount: built.sendAmount,
    slippageBps: DEFAULT_SLIPPAGE_BPS,
    quote: fresh.quote,
  })
}

/**
 * Builds an Aquarius swap against the pool the agent chose.
 *
 * Re-quoted like every other venue, but re-quoted *for the same pool*. An
 * Aquarius pair can have several pools — XLM/USDC has three — and the agent
 * compared them and picked one. Re-quoting "the best" here could pick a
 * different pool than the one that won, and the user would sign a route
 * nobody had reviewed. So the quoted pool index selects which fresh quote is
 * used, and a quote without an index is refused rather than defaulted.
 */
async function buildViaAquarius(account: string, submitted: SwapQuote): Promise<NextResponse> {
  if (submitted.poolIndex === undefined) {
    return NextResponse.json(
      { error: 'an Aquarius route must name the pool it was quoted from' },
      { status: 400 }
    )
  }

  const all = await createAquariusQuoter().quoteAll?.({
    kind: 'strict_send',
    from: submitted.from,
    to: submitted.to,
    sendAmount: submitted.sendAmount,
  })

  if (all === undefined || !all.ok) {
    return NextResponse.json(
      { error: 'no_route', reason: all?.ok === false ? all.failure.reason : 'no_route' },
      { status: 200 }
    )
  }

  const fresh = all.quotes.find((q) => q.poolIndex === submitted.poolIndex)
  if (fresh === undefined) {
    // The pool existed when quoted and does not now — a drained pool, or a
    // testnet reset between quote and build. Said plainly rather than
    // silently substituting whichever pool remains.
    return NextResponse.json(
      { error: 'no_route', reason: 'the quoted pool is no longer available' },
      { status: 200 }
    )
  }

  const minReceive = applySlippage(fresh.destAmount, DEFAULT_SLIPPAGE_BPS)

  let built
  try {
    built = await buildAquariusSwap({
      account,
      from: fresh.from,
      to: fresh.to,
      sendAmount: fresh.sendAmount,
      minReceive,
      poolIndex: submitted.poolIndex,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'could not build the transaction' },
      { status: 400 }
    )
  }

  // Venue-agnostic: it simulates and assembles whatever envelope it is given.
  const prepared = await prepareSorobanSwap(built.xdr)
  if (!prepared.ok) {
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
    quote: fresh,
  })
}
