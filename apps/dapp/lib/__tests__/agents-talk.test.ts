import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentProposalResult, TalkCall, TalkOutcome } from '../agents/brain'
import { runTalk, type TalkSeat } from '../agents/talk'
import type { FinalChoice } from '../agents/talk-prompts'
import type { TalkLine } from '../agents/talk-lines'

const meta = {
  provider: 'groq' as const,
  model: 'm',
  latencyMs: 1,
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  costUsd: 0,
}

const plan = (agent: string, routeId = 'jupiter-1'): AgentProposalResult => ({
  agent,
  routeId,
  reasoning: `${agent} first take`,
  projectedAvgPriceUsd: 1,
  projectedSlippagePct: 0,
  venues: [],
  sliceCount: 1,
  confidence: 0.5,
  horizonMinutes: 0,
  executionMode: 'fill',
})

type Reply = unknown | ((call: TalkCall) => Promise<TalkOutcome>)

const ok = (args: unknown): TalkOutcome => ({ ok: true, args, meta })
const keep = {
  decision: 'keep',
  routeId: '',
  executionMode: 'fill',
  restPriceUsd: 0,
  splitPct: 0,
  reasoning: 'Stays.',
}

/** A seat whose model replies by tool name. Anything unlisted replies with nothing useful. */
function seat(key: string, replies: Record<string, Reply> = {}): TalkSeat & { calls: TalkCall[] } {
  const calls: TalkCall[] = []
  return {
    key,
    name: key.toUpperCase(),
    calls,
    talk: async (call: TalkCall) => {
      calls.push(call)
      const reply = replies[call.tool.name]
      if (typeof reply === 'function') {
        return (reply as (c: TalkCall) => Promise<TalkOutcome>)(call)
      }
      if (reply !== undefined) return ok(reply)
      if (call.tool.name === 'final_plan') return ok(keep)
      return ok({ to: '', question: '', answer: '' })
    },
  }
}

const asks = (to: string, question = 'Why that route?'): Record<string, unknown> => ({
  ask_agent: { to, question },
})

/** Replies only when aborted, as a model past its turn does. */
const neverAnswers = (call: TalkCall): Promise<TalkOutcome> =>
  new Promise((resolve) => {
    call.signal?.addEventListener('abort', () => resolve({ ok: false, error: 'timeout', meta }))
  })

const later = <T>(ms: number, value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms))

function start(
  seats: TalkSeat[],
  takes: Promise<AgentProposalResult | undefined>[],
  overrides: {
    applyFinal?: (agent: string, choice: FinalChoice) => AgentProposalResult | undefined
    onRateLimited?: (agent: string, ms: number | undefined) => void
    signal?: AbortSignal
  } = {}
) {
  const lines: TalkLine[] = []
  const closeLateTakes = vi.fn()
  const done = runTalk({
    seats,
    takes,
    facts: { chain: 'solana', intent: 'swap 100 USDC to SOL', routes: [] },
    startedAt: Date.now(),
    emit: (line) => lines.push(line),
    applyFinal:
      overrides.applyFinal ??
      ((agent, choice) => {
        const first = plan(agent)
        if (choice.decision === 'hold') {
          return { ...first, reasoning: choice.reasoning, held: true }
        }
        if (choice.decision === 'change') {
          return { ...first, routeId: choice.routeId, reasoning: choice.reasoning }
        }
        return { ...first, reasoning: choice.reasoning }
      }),
    closeLateTakes,
    onRateLimited: overrides.onRateLimited ?? (() => undefined),
    ...(overrides.signal !== undefined ? { signal: overrides.signal } : {}),
  })
  return { lines, closeLateTakes, done }
}

const kinds = (lines: TalkLine[]): string[] =>
  lines.map((l) => (l.kind === 'turn' ? `turn ${l.turn}` : l.kind))

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('runTalk', () => {
  it('calls no model to talk until first takes have landed', async () => {
    const a = seat('a')
    const b = seat('b')
    const run = start([a, b], [later(3000, plan('a')), later(3000, plan('b'))])
    await vi.advanceTimersByTimeAsync(2999)
    expect(a.calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(10_000)
    await run.done
    expect(a.calls.length).toBeGreaterThan(0)
  })

  it('runs ask, answer and final in order', async () => {
    const run = start(
      [seat('a', asks('B')), seat('b', { answer_agents: { answer: 'Fees.' } })],
      [Promise.resolve(plan('a')), Promise.resolve(plan('b'))]
    )
    await vi.advanceTimersByTimeAsync(20_000)
    await run.done
    expect(kinds(run.lines)).toEqual([
      'turn ask',
      'reading',
      'reading',
      'asked',
      'turn answer',
      'answered',
      'turn final',
    ])
    expect(run.lines[1]).toEqual({ kind: 'reading', agent: 'a', of: ['b'] })
    expect(run.lines[3]).toEqual({ kind: 'asked', agent: 'a', to: 'b', text: 'Why that route?' })
    expect(run.lines[5]).toEqual({ kind: 'answered', agent: 'b', to: ['a'], text: 'Fees.' })
  })

  it('waits until 8 seconds for every first take, then opens with what it has', async () => {
    const a = seat('a')
    const run = start(
      [a, seat('b'), seat('c')],
      [Promise.resolve(plan('a')), Promise.resolve(plan('b')), later(25_000, undefined)]
    )
    await vi.advanceTimersByTimeAsync(7999)
    expect(a.calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(a.calls.length).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(17_000)
    await run.done
    expect(run.closeLateTakes).toHaveBeenCalled()
  })

  it('opens when the second first take lands, if only one was in at 8 seconds', async () => {
    const a = seat('a')
    const run = start([a, seat('b')], [Promise.resolve(plan('a')), later(12_000, plan('b'))])
    await vi.advanceTimersByTimeAsync(11_999)
    expect(a.calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(a.calls.length).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(8000)
    expect((await run.done).talked).toBe(true)
  })

  it('does not open after 14 seconds, and still ends by 20', async () => {
    const a = seat('a')
    const b = seat('b')
    const lateTake = new Promise<AgentProposalResult | undefined>(() => undefined)
    const run = start([a, b], [Promise.resolve(plan('a')), lateTake])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(run.closeLateTakes).toHaveBeenCalled()
  })

  it('talks with nobody when only one agent answered, and keeps its take', async () => {
    const a = seat('a')
    const run = start([a, seat('b')], [Promise.resolve(plan('a')), Promise.resolve(undefined)])
    await vi.advanceTimersByTimeAsync(1)
    const result = await run.done
    expect(result.talked).toBe(false)
    expect(result.finals.map((f) => f.agent)).toEqual(['a'])
    expect(a.calls).toHaveLength(0)
    expect(run.lines).toEqual([])
  })

  it('waits on as today when nobody has answered by 20 seconds', async () => {
    const a = seat('a')
    const run = start([a, seat('b')], [later(30_000, plan('a')), later(30_000, plan('b'))])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(run.closeLateTakes).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await run.done
    expect(result.talked).toBe(false)
    expect(result.finals).toHaveLength(2)
    expect(a.calls).toHaveLength(0)
  })

  it('calls only agents that were asked in the answer turn, once for all questions', async () => {
    const a = seat('a', asks('C'))
    const b = seat('b', asks('C'))
    const c = seat('c', { answer_agents: { answer: 'Fees.' } })
    const run = start(
      [a, b, c],
      [Promise.resolve(plan('a')), Promise.resolve(plan('b')), Promise.resolve(plan('c'))]
    )
    await vi.advanceTimersByTimeAsync(20_000)
    await run.done
    expect(a.calls.filter((x) => x.tool.name === 'answer_agents')).toHaveLength(0)
    expect(c.calls.filter((x) => x.tool.name === 'answer_agents')).toHaveLength(1)
    expect(run.lines.find((l) => l.kind === 'answered')).toEqual({
      kind: 'answered',
      agent: 'c',
      to: ['a', 'b'],
      text: 'Fees.',
    })
  })

  it('skips the answer turn when nobody asked', async () => {
    const run = start(
      [seat('a'), seat('b')],
      [Promise.resolve(plan('a')), Promise.resolve(plan('b'))]
    )
    await vi.advanceTimersByTimeAsync(20_000)
    await run.done
    expect(kinds(run.lines)).not.toContain('turn answer')
  })

  it('says nothing for a late question', async () => {
    const run = start(
      [seat('a', { ask_agent: neverAnswers }), seat('b')],
      [Promise.resolve(plan('a')), Promise.resolve(plan('b'))]
    )
    await vi.advanceTimersByTimeAsync(20_000)
    await run.done
    expect(kinds(run.lines)).not.toContain('asked')
  })

  it('says so when an agent misses its answer, and invents no words', async () => {
    const run = start(
      [seat('a', asks('B')), seat('b', { answer_agents: neverAnswers })],
      [Promise.resolve(plan('a')), Promise.resolve(plan('b'))]
    )
    await vi.advanceTimersByTimeAsync(20_000)
    await run.done
    expect(run.lines).toContainEqual({ kind: 'no_answer', agent: 'b', to: ['a'] })
    expect(kinds(run.lines)).not.toContain('answered')
  })

  it.each([
    ['late', { final_plan: neverAnswers }],
    ['unreadable', { final_plan: { decision: 'merge', reasoning: 'x' } }],
    [
      'failed',
      {
        final_plan: async (): Promise<TalkOutcome> => ({
          ok: false,
          error: 'upstream_error',
          meta,
        }),
      },
    ],
  ])('keeps the first take when a final is %s', async (_, replies) => {
    const first = plan('a')
    const run = start(
      [seat('a', replies), seat('b')],
      [Promise.resolve(first), Promise.resolve(plan('b'))]
    )
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await run.done
    expect(result.finals.find((f) => f.agent === 'a')).toBe(first)
    expect(kinds(run.lines)).not.toContain('changed')
  })

  it('keeps the first take when a change fails the checks', async () => {
    const first = plan('a')
    const run = start(
      [
        seat('a', {
          final_plan: { ...keep, decision: 'change', routeId: 'nope-1', reasoning: 'Moved.' },
        }),
        seat('b'),
      ],
      [Promise.resolve(first), Promise.resolve(plan('b'))],
      { applyFinal: (agent) => (agent === 'a' ? undefined : plan(agent)) }
    )
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await run.done
    expect(result.finals.find((f) => f.agent === 'a')).toBe(first)
  })

  it('gives a take that landed during talk the final turn', async () => {
    const c = seat('c')
    const run = start(
      [seat('a', { ask_agent: neverAnswers }), seat('b'), c],
      [Promise.resolve(plan('a')), Promise.resolve(plan('b')), later(10_000, plan('c'))]
    )
    await vi.advanceTimersByTimeAsync(20_000)
    await run.done
    expect(c.calls.map((x) => x.tool.name)).toEqual(['final_plan'])
  })

  it('reports a change only when route or mode really moved', async () => {
    const run = start(
      [
        seat('a', {
          final_plan: { ...keep, decision: 'change', routeId: 'oneclick-1', reasoning: 'Moved.' },
        }),
        seat('b', {
          final_plan: { ...keep, decision: 'change', routeId: 'jupiter-1', reasoning: 'Same.' },
        }),
        seat('c'),
      ],
      [Promise.resolve(plan('a')), Promise.resolve(plan('b')), Promise.resolve(plan('c'))]
    )
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await run.done
    expect(run.lines.filter((l) => l.kind === 'changed')).toEqual([{ kind: 'changed', agent: 'a' }])
    expect(result.changed).toBe(1)
  })

  it('reports a hold, and counts it apart from a change', async () => {
    const run = start(
      [seat('a', { final_plan: { ...keep, decision: 'hold', reasoning: 'Not now.' } }), seat('b')],
      [Promise.resolve(plan('a')), Promise.resolve(plan('b'))]
    )
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await run.done
    expect(run.lines).toContainEqual({ kind: 'held', agent: 'a' })
    expect(result.held).toBe(1)
    expect(result.changed).toBe(0)
  })

  it('ends by 20 seconds however slow the models are', async () => {
    const slow = { ask_agent: neverAnswers, answer_agents: neverAnswers, final_plan: neverAnswers }
    const run = start(
      [seat('a', slow), seat('b', slow)],
      [Promise.resolve(plan('a')), Promise.resolve(plan('b'))]
    )
    let finished = false
    void run.done.then(() => (finished = true))
    await vi.advanceTimersByTimeAsync(19_999)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(finished).toBe(true)
  })

  it('stops waiting on a model that ignores the abort', async () => {
    const deaf = (): Promise<TalkOutcome> => new Promise(() => undefined)
    const run = start(
      [seat('a', { ask_agent: deaf, final_plan: deaf }), seat('b')],
      [Promise.resolve(plan('a')), Promise.resolve(plan('b'))]
    )
    await vi.advanceTimersByTimeAsync(20_000)
    expect((await run.done).finals).toHaveLength(2)
  })

  it('stops calling models and ends at once when the person has left', async () => {
    const left = new AbortController()
    const a = seat('a', { ask_agent: neverAnswers })
    const b = seat('b', { ask_agent: neverAnswers })
    const run = start([a, b], [Promise.resolve(plan('a')), Promise.resolve(plan('b'))], {
      signal: left.signal,
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(a.calls.map((c) => c.tool.name)).toEqual(['ask_agent'])
    const asked = a.calls[0]?.signal

    left.abort()
    await vi.advanceTimersByTimeAsync(0)
    const result = await run.done

    expect(asked?.aborted).toBe(true)
    expect(a.calls.map((c) => c.tool.name)).toEqual(['ask_agent'])
    expect(result.finals).toHaveLength(2)
  })

  it('ends first takes still running when the person has left, even with no answer yet', async () => {
    const left = new AbortController()
    const run = start([seat('a'), seat('b')], [later(30_000, undefined), later(30_000, undefined)], {
      signal: left.signal,
    })
    await vi.advanceTimersByTimeAsync(1000)
    left.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(run.closeLateTakes).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    await run.done
  })

  it('shares a turn among what time is left', async () => {
    const seenAt: Record<string, number> = {}
    const started = Date.now()
    const note = (name: string, reply: unknown) => async (): Promise<TalkOutcome> => {
      seenAt[name] = Date.now() - started
      return ok(reply)
    }
    const run = start(
      [
        seat('a', {
          ask_agent: async (call: TalkCall) => {
            seenAt['ask'] = Date.now() - started
            return neverAnswers(call)
          },
          final_plan: note('final', keep),
        }),
        seat('b', { ask_agent: neverAnswers, final_plan: keep }),
      ],
      [Promise.resolve(plan('a')), Promise.resolve(plan('b'))]
    )
    await vi.advanceTimersByTimeAsync(20_000)
    await run.done
    expect(seenAt['ask']).toBe(0)
    // Nobody asked, so one third goes to asking and the rest to the final turn.
    expect(seenAt['final']).toBeGreaterThanOrEqual(6666)
    expect(seenAt['final']).toBeLessThanOrEqual(6667)
  })

  it("reports a 429 and keeps the agent's plan", async () => {
    const limited = vi.fn()
    const first = plan('a')
    const run = start(
      [
        seat('a', {
          ask_agent: async (): Promise<TalkOutcome> => ({
            ok: false,
            error: 'rate_limited',
            meta,
            retryAfterMs: 5000,
          }),
          final_plan: async (): Promise<TalkOutcome> => ({
            ok: false,
            error: 'rate_limited',
            meta,
          }),
        }),
        seat('b'),
      ],
      [Promise.resolve(first), Promise.resolve(plan('b'))],
      { onRateLimited: limited }
    )
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await run.done
    expect(limited).toHaveBeenCalledWith('a', 5000)
    expect(result.finals.find((f) => f.agent === 'a')).toBe(first)
  })

  it("never lets one agent's reply change another agent's plan", async () => {
    const firstB = plan('b')
    const applied: string[] = []
    const run = start(
      [
        seat('a', {
          final_plan: { ...keep, decision: 'change', routeId: 'oneclick-1', reasoning: 'Moved.' },
        }),
        seat('b', { final_plan: { decision: 'merge', reasoning: 'x' } }),
      ],
      [Promise.resolve(plan('a')), Promise.resolve(firstB)],
      {
        applyFinal: (agent, choice) => {
          applied.push(agent)
          return { ...plan(agent), reasoning: choice.reasoning }
        },
      }
    )
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await run.done
    expect(applied).toEqual(['a'])
    expect(result.finals.find((f) => f.agent === 'b')).toBe(firstB)
  })

  it('reads the plans each agent was shown, leaving out its own from the others', async () => {
    const a = seat('a')
    const run = start([a, seat('b')], [Promise.resolve(plan('a')), Promise.resolve(plan('b'))])
    await vi.advanceTimersByTimeAsync(20_000)
    await run.done
    const ask = a.calls.find((c) => c.tool.name === 'ask_agent')
    expect(ask?.user).toContain('b first take')
    expect(ask?.user.slice(ask.user.indexOf('OTHER AGENTS'))).not.toContain('a first take')
  })
})
