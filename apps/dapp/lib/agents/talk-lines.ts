/**
 * What agents say to each other, as it reaches the chat.
 *
 * Shared by the server, which sends these, and the client, which shows them,
 * so nothing here touches a model or a network. Each line reports something
 * that happened in this race: a `reading` line is sent when that agent's call
 * starts, and its `of` is the plans that call was given. There is no wording
 * here for anything an agent says; that text only ever comes from its model.
 */

export type TalkLine =
  | { kind: 'turn'; turn: 'ask' | 'answer' | 'final'; agents: string[] }
  | { kind: 'reading'; agent: string; of: string[] }
  | { kind: 'asked'; agent: string; to: string; text: string }
  | { kind: 'answered'; agent: string; to: string[]; text: string }
  | { kind: 'no_answer'; agent: string; to: string[] }
  | { kind: 'changed'; agent: string }
  | { kind: 'held'; agent: string }

/** One entry in the thread, in the order it happened. A take's words are looked up by agent. */
export type ThreadItem = { type: 'take'; agent: string } | { type: 'line'; line: TalkLine }

function listed(parts: string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** The sentence for a line shown as a note from the room, or nothing if it isn't one. */
export function talkPill(line: TalkLine, nameOf: (key: string) => string): string | undefined {
  switch (line.kind) {
    case 'reading':
      return `${nameOf(line.agent)} is reading ${listed(line.of.map((k) => `${nameOf(k)}'s`))} ${
        line.of.length === 1 ? 'strategy' : 'strategies'
      }`
    case 'no_answer':
      return `${nameOf(line.agent)} did not answer in time.`
    case 'changed':
      return `${nameOf(line.agent)} changed its strategy.`
    case 'held':
      return `${nameOf(line.agent)} would not do this now.`
    default:
      return undefined
  }
}

/** Who is speaking to whom, for a line shown as an agent's message. */
export function talkSpeaker(line: TalkLine, nameOf: (key: string) => string): string | undefined {
  if (line.kind === 'asked') return `${nameOf(line.agent)} to ${nameOf(line.to)}`
  if (line.kind === 'answered') return `${nameOf(line.agent)} to ${listed(line.to.map(nameOf))}`
  return undefined
}

/**
 * Which agents still have a model call out, as far as the thread shows.
 *
 * Agents with no first take yet, plus the latest turn's agents who haven't
 * spoken in it. `done` is true for an agent with a failure or a final card.
 */
export function waitingAgents(
  agents: string[],
  items: ThreadItem[],
  done: (key: string) => boolean
): string[] {
  const took = new Set(items.flatMap((i) => (i.type === 'take' ? [i.agent] : [])))
  const lines = items.flatMap((i) => (i.type === 'line' ? [i.line] : []))
  const turnAt = lines.map((l) => l.kind).lastIndexOf('turn')
  const turn = lines[turnAt]
  const inTurn = turn?.kind === 'turn' ? turn.agents : []
  const spoke = new Set(
    lines
      .slice(turnAt + 1)
      .flatMap((l) => (l.kind === 'asked' || l.kind === 'answered' ? [l.agent] : []))
  )
  return agents.filter(
    (key) => !done(key) && (!took.has(key) || (inTurn.includes(key) && !spoke.has(key)))
  )
}

/**
 * Whether first takes stay in the thread. Once decided with no talk, each take
 * says what its final card says, so the card stands alone as it did before talk.
 */
export function showTakes(items: ThreadItem[], phase: string): boolean {
  if (phase !== 'decided') return true
  return items.some((i) => i.type === 'line' && i.line.kind !== 'turn')
}

export const ALL_HELD_LINE =
  'No agent would do this right now, so there is nothing to sign. Ask again if you still want it.'

/** Every agent that answered held off, so there is nothing to recommend. */
export function allHeld(views: { held?: true | undefined; failed?: string | undefined }[]): boolean {
  const answered = views.filter((v) => v.failed === undefined)
  return answered.length > 0 && answered.every((v) => v.held === true)
}
