import { NextResponse } from 'next/server'
import { z } from 'zod'

import { readSessionFromRequest } from '../../../lib/server/session'
import { getStandingRulesRepo } from '../../../lib/server/standing-rules'
import type { StandingIntent } from '../../../lib/standing-intent'

/**
 * A user's standing rules, on the server.
 *
 * Scoped by the session's email: a rule belongs to whoever was signed in
 * when it was created, and every read and write here is filtered by that.
 * The wallet the client sends is recorded alongside, because the rule will
 * trade from a particular account and the list can be narrowed to it.
 *
 * Nothing here evaluates or executes anything. Creating a rule stores it;
 * the tick decides when it fires; the user signs. Reporting a firing from the
 * client (`PATCH`) exists so a rule that came due while a tab was open is
 * marked the same way the tick would mark it, and the tick does not fire it
 * a second time.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const priceTrigger = { asset: z.string().min(1).max(16), priceUsd: z.number().positive() }

const ruleSchema = z.object({
  id: z.string().min(1).max(64),
  chain: z.string().min(1).max(32),
  text: z.string().min(1).max(500),
  createdAt: z.string().datetime(),
  trigger: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('price_below'), ...priceTrigger }),
    z.object({ kind: z.literal('price_above'), ...priceTrigger }),
    z.object({
      kind: z.literal('schedule'),
      everyHours: z
        .number()
        .positive()
        .max(24 * 365),
    }),
  ]),
  action: z.object({
    kind: z.literal('swap'),
    from: z.string().min(1).max(16),
    to: z.string().min(1).max(16),
    amountIn: z.string().min(1).max(40),
  }),
  status: z.enum(['armed', 'fired', 'cancelled', 'expired']),
  expiresAt: z.string().datetime().optional(),
  lastFiredAt: z.string().datetime().optional(),
})

const createSchema = z.object({
  wallet: z.string().max(128),
  rule: ruleSchema,
})

const firedSchema = z.object({
  id: z.string().min(1).max(64),
  at: z.string().datetime(),
  price: z.number().positive().optional(),
  /** True when the user signed it themselves: nothing to email, nothing to show. */
  executed: z.boolean().optional(),
})

function toIntent(parsed: z.infer<typeof ruleSchema>): StandingIntent {
  return {
    id: parsed.id,
    chain: parsed.chain,
    text: parsed.text,
    createdAt: parsed.createdAt,
    trigger: parsed.trigger,
    action: parsed.action,
    status: parsed.status,
    ...(parsed.expiresAt !== undefined ? { expiresAt: parsed.expiresAt } : {}),
    ...(parsed.lastFiredAt !== undefined ? { lastFiredAt: parsed.lastFiredAt } : {}),
  }
}

const unauthorised = (): NextResponse =>
  NextResponse.json({ error: 'unauthorised' }, { status: 401 })

export async function GET(request: Request): Promise<NextResponse> {
  const session = readSessionFromRequest(request)
  if (session === undefined) return unauthorised()

  const url = new URL(request.url)
  const chain = url.searchParams.get('chain')
  if (chain === null || chain === '') {
    return NextResponse.json({ error: 'chain_required' }, { status: 400 })
  }
  const wallet = url.searchParams.get('wallet')

  const repo = await getStandingRulesRepo()
  const rules = await repo.listRules(session.email, chain)
  return NextResponse.json({
    rules: wallet === null || wallet === '' ? rules : rules.filter((r) => r.wallet === wallet),
  })
}

export async function POST(request: Request): Promise<NextResponse> {
  const session = readSessionFromRequest(request)
  if (session === undefined) return unauthorised()

  let body: z.infer<typeof createSchema>
  try {
    body = createSchema.parse(await request.json())
  } catch {
    return NextResponse.json({ error: 'invalid_rule' }, { status: 400 })
  }

  const repo = await getStandingRulesRepo()
  const stored = await repo.createRule({
    email: session.email,
    wallet: body.wallet,
    rule: toIntent(body.rule),
  })
  // The id is taken by another owner. Ids are client-generated, so this is
  // possible by accident as well as by design; either way it is not theirs.
  if (stored === undefined) return NextResponse.json({ error: 'id_taken' }, { status: 409 })

  return NextResponse.json({ rule: stored }, { status: 201 })
}

export async function PATCH(request: Request): Promise<NextResponse> {
  const session = readSessionFromRequest(request)
  if (session === undefined) return unauthorised()

  let body: z.infer<typeof firedSchema>
  try {
    body = firedSchema.parse(await request.json())
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  const repo = await getStandingRulesRepo()
  const owned = await repo.findRule(session.email, body.id)
  if (owned === undefined) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const at = new Date(body.at)
  // Same marks the tick would set, so a firing seen in a tab and a firing
  // found by the tick are one event, not two.
  await repo.markFired(body.id, body.price ?? null, at)
  if (body.executed === true) {
    // The user signed it themselves. There is nothing to tell them and
    // nothing for them to look at.
    await repo.markNotified(body.id, at)
    await repo.markSeen(session.email, [body.id], at)
  }

  const updated = await repo.findRule(session.email, body.id)
  return NextResponse.json({ rule: updated })
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const session = readSessionFromRequest(request)
  if (session === undefined) return unauthorised()

  const id = new URL(request.url).searchParams.get('id')
  if (id === null || id === '') return NextResponse.json({ error: 'id_required' }, { status: 400 })

  const repo = await getStandingRulesRepo()
  const cancelled = await repo.cancelRule(session.email, id)
  if (!cancelled) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  return NextResponse.json({ status: 'cancelled' })
}
