import type { AgentBrain, AgentProposalResult, TalkCall, TalkOutcome } from './brain'
import { TALK_CLOSE_MS } from './pacing'
import type { TalkLine } from './talk-lines'
import {
  ANSWER_TOOL,
  ASK_TOOL,
  FINAL_TOOL,
  answerPrompt,
  askPrompt,
  finalPrompt,
  planSummary,
  readAnswer,
  readFinal,
  readQuestion,
  type FinalChoice,
  type TalkFacts,
  type TalkPrompt,
  type TalkSelf,
  type TalkTool,
} from './talk-prompts'

/**
 * Agents reading each other's plans, questioning each other, and each deciding
 * its own final plan, under one deadline.
 *
 * First takes are made alone, before this has anything to show anyone. After
 * that, each agent gets one chance to ask and, if asked, one to answer, then
 * decides for itself. There is no vote and no merge: a final plan comes only
 * from that agent's own model, and whatever goes wrong leaves its first take
 * standing. Whether agents end up alike or apart is left to them.
 */

export const TALK_OPEN_MS = 8_000
export const TALK_LATEST_OPEN_MS = 14_000
export { TALK_CLOSE_MS }

export interface TalkSeat {
  key: string
  name: string
  talk?: NonNullable<AgentBrain['talk']> | undefined
}

export interface TalkResult {
  /** Each answering agent's final plan, in seat order. */
  finals: AgentProposalResult[]
  talked: boolean
  questions: number
  changed: number
  held: number
}

export interface TalkInput {
  seats: TalkSeat[]
  /** First takes, in seat order, already running. */
  takes: Promise<AgentProposalResult | undefined>[]
  facts: Omit<TalkFacts, 'plans'>
  /** When the clock started: the moment the line-up was sent. */
  startedAt: number
  emit: (line: TalkLine) => void
  /** Turns a final choice into a checked plan, or nothing if it doesn't hold up. */
  applyFinal: (agent: string, choice: FinalChoice) => AgentProposalResult | undefined
  /** Ends first takes still running. Called at the close, only if someone has answered. */
  closeLateTakes: () => void
  onRateLimited: (agent: string, retryAfterMs: number | undefined) => void
}

interface Exchange {
  from: string
  to: string
  text: string
}

export async function runTalk(input: TalkInput): Promise<TalkResult> {
  const { seats, takes, facts, startedAt, emit } = input
  const landed = new Map<string, AgentProposalResult>()
  const finals = new Map<string, AgentProposalResult>()
  let settled = 0
  let changedCount = 0
  let heldCount = 0
  let wake: (() => void) | undefined

  takes.forEach((take, i) => {
    void take.then((plan) => {
      const seat = seats[i]
      if (plan !== undefined && seat !== undefined) landed.set(seat.key, plan)
      settled += 1
      wake?.()
    })
  })

  const allSettled = (): boolean => settled >= takes.length
  const elapsed = (): number => Date.now() - startedAt
  const left = (): number => TALK_CLOSE_MS - elapsed()

  /** Resolves when `ready` holds or the clock reaches `atMs`, whichever comes first. */
  const until = async (ready: () => boolean, atMs: number): Promise<void> => {
    while (!ready() && elapsed() < atMs) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, atMs - elapsed())
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      wake = undefined
    }
  }

  const finish = async (talked: boolean, questions: number): Promise<TalkResult> => {
    await until(allSettled, TALK_CLOSE_MS)
    if (!allSettled()) {
      if (landed.size > 0) input.closeLateTakes()
      await Promise.all(takes)
    }
    const inOrder = seats.flatMap((s) => {
      const plan = finals.get(s.key) ?? landed.get(s.key)
      return plan !== undefined ? [plan] : []
    })
    return {
      finals: inOrder,
      talked,
      questions,
      changed: changedCount,
      held: heldCount,
    }
  }

  // Talk opens with every first take in, or at 8 seconds with at least two,
  // or when a second lands, but never so late that its turns would be empty.
  await until(allSettled, TALK_OPEN_MS)
  await until(() => landed.size >= 2 || allSettled(), TALK_LATEST_OPEN_MS)

  const talking = (): TalkSeat[] => seats.filter((s) => s.talk !== undefined && landed.has(s.key))
  if (landed.size < 2 || talking().length < 2 || left() <= 0) return finish(false, 0)

  const self = (seat: TalkSeat): TalkSelf => ({ key: seat.key, name: seat.name })
  const nameOf = (key: string): string => seats.find((s) => s.key === key)?.name ?? key
  const seatIndex = (seat: TalkSeat): number => seats.indexOf(seat)
  const factsNow = (): TalkFacts => ({
    ...facts,
    plans: seats.flatMap((s) => {
      const plan = landed.get(s.key)
      return plan !== undefined
        ? [
            {
              key: s.key,
              name: s.name,
              plan: planSummary(plan, facts.routes),
              reasoning: plan.reasoning,
            },
          ]
        : []
    }),
  })

  /** One model call that ends at `deadlineAt` whether or not the model honours the abort. */
  const call = async (
    seat: TalkSeat,
    prompt: TalkPrompt,
    tool: TalkTool,
    deadlineAt: number
  ): Promise<TalkOutcome | undefined> => {
    const talk = seat.talk
    if (talk === undefined) return undefined
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<undefined>((resolve) => {
      timer = setTimeout(
        () => {
          abort.abort()
          resolve(undefined)
        },
        Math.max(0, deadlineAt - elapsed())
      )
    })
    const request: TalkCall = { agent: seat.key, ...prompt, tool, signal: abort.signal }
    const outcome = await Promise.race([talk(request), expired])
    clearTimeout(timer)
    if (outcome !== undefined && !outcome.ok && outcome.error === 'rate_limited') {
      input.onRateLimited(seat.key, outcome.retryAfterMs)
    }
    return outcome
  }

  const said: string[] = []
  const exchanges: Exchange[] = []

  // Ask. Each agent reads what the others hold now, and "reading" is sent as
  // its call starts, naming exactly the plans that call was given.
  const asking = talking()
  emit({ kind: 'turn', turn: 'ask', agents: asking.map((s) => s.key) })
  const askBy = elapsed() + left() / 3
  await Promise.all(
    asking.map(async (seat) => {
      const others = asking.filter((s) => s !== seat)
      emit({ kind: 'reading', agent: seat.key, of: others.map((s) => s.key) })
      const outcome = await call(
        seat,
        askPrompt(self(seat), factsNow(), seatIndex(seat)),
        ASK_TOOL,
        askBy
      )
      if (outcome === undefined || !outcome.ok) return
      const question = readQuestion(outcome.args, others.map(self))
      if (question === undefined) return
      exchanges.push({ from: seat.key, to: question.to, text: question.text })
      said.push(`${seat.name} to ${nameOf(question.to)}: ${question.text}`)
      emit({ kind: 'asked', agent: seat.key, to: question.to, text: question.text })
    })
  )

  // Answer. Only agents someone asked make a call, and one call covers them all.
  const asked = seats.filter((s) => exchanges.some((q) => q.to === s.key))
  if (asked.length > 0 && left() > 0) {
    emit({ kind: 'turn', turn: 'answer', agents: asked.map((s) => s.key) })
    const answerBy = elapsed() + left() / 2
    await Promise.all(
      asked.map(async (seat) => {
        const mine = exchanges.filter((q) => q.to === seat.key)
        const askers = mine.map((q) => q.from)
        const outcome = await call(
          seat,
          answerPrompt(
            self(seat),
            factsNow(),
            mine.map((q) => ({ from: nameOf(q.from), text: q.text })),
            seatIndex(seat)
          ),
          ANSWER_TOOL,
          answerBy
        )
        const text = outcome?.ok === true ? readAnswer(outcome.args) : undefined
        if (text === undefined) {
          emit({ kind: 'no_answer', agent: seat.key, to: askers })
          return
        }
        said.push(`${seat.name} to ${askers.map(nameOf).join(' and ')}: ${text}`)
        emit({ kind: 'answered', agent: seat.key, to: askers, text })
      })
    )
  }

  // Final. An agent decides alone, having read everything. Whoever came in late
  // and still has time gets this turn too.
  const decided = new Set<string>()
  const allowedRouteIds = facts.routes.filter((r) => r.executable).map((r) => r.id)
  const finalTurn = async (): Promise<void> => {
    const deciding = talking().filter((s) => !decided.has(s.key))
    if (deciding.length === 0 || left() <= 0) return
    emit({ kind: 'turn', turn: 'final', agents: deciding.map((s) => s.key) })
    await Promise.all(
      deciding.map(async (seat) => {
        decided.add(seat.key)
        const first = landed.get(seat.key)
        if (first === undefined) return
        const outcome = await call(
          seat,
          finalPrompt(self(seat), factsNow(), said, seatIndex(seat)),
          FINAL_TOOL,
          TALK_CLOSE_MS
        )
        const choice = outcome?.ok === true ? readFinal(outcome.args, allowedRouteIds) : undefined
        if (choice === undefined) return
        const final = input.applyFinal(seat.key, choice)
        if (final === undefined) return
        finals.set(seat.key, final)
        if (final.held === true) {
          heldCount += 1
          emit({ kind: 'held', agent: seat.key })
        } else if (final.routeId !== first.routeId || final.executionMode !== first.executionMode) {
          changedCount += 1
          emit({ kind: 'changed', agent: seat.key })
        }
      })
    )
  }

  await finalTurn()
  while (left() > 0 && !allSettled()) {
    await until(() => allSettled() || talking().some((s) => !decided.has(s.key)), TALK_CLOSE_MS)
    await finalTurn()
  }

  return finish(true, exchanges.length)
}
