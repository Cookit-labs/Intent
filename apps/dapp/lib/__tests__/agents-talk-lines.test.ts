import { describe, expect, it } from 'vitest'

import { planTalkReveal } from '../agents/pacing'
import {
  ALL_HELD_LINE,
  allHeld,
  isProofLine,
  showTakes,
  talkPill,
  talkSpeaker,
  waitingAgents,
  type ThreadItem,
} from '../agents/talk-lines'

const names: Record<string, string> = { s: 'Sonnet', j: 'Jeff', o: 'Opus', l: 'Ling' }
const nameOf = (key: string): string => names[key] ?? key

describe('a proof note', () => {
  const proof: ThreadItem = { type: 'line', line: { kind: 'verified', agent: 'j' } }

  it('says the answer was signed inside a verified NEAR AI enclave', () => {
    expect(talkPill({ kind: 'verified', agent: 'j' }, nameOf)).toBe(
      "Jeff's answer was signed inside a verified NEAR AI enclave."
    )
  })

  it('keeps the takes of a decided race that never talked off the thread', () => {
    expect(showTakes([{ type: 'take', agent: 'j' }, proof], 'decided')).toBe(false)
    expect(isProofLine(proof)).toBe(true)
    expect(isProofLine({ type: 'take', agent: 'j' })).toBe(false)
  })
})

describe('talkPill', () => {
  it('names what the agent was given to read', () => {
    const pill = (of: string[]): string | undefined =>
      talkPill({ kind: 'reading', agent: 's', of }, nameOf)
    expect(pill(['j'])).toBe("Sonnet is reading Jeff's strategy")
    expect(pill(['j', 'o'])).toBe("Sonnet is reading Jeff's and Opus's strategies")
    expect(pill(['j', 'o', 'l'])).toBe("Sonnet is reading Jeff's, Opus's and Ling's strategies")
  })

  it('says what happened to an agent', () => {
    expect(talkPill({ kind: 'no_answer', agent: 'j', to: ['s'] }, nameOf)).toBe(
      'Jeff did not answer.'
    )
    expect(talkPill({ kind: 'changed', agent: 's' }, nameOf)).toBe('Sonnet changed its strategy.')
    expect(talkPill({ kind: 'held', agent: 'o' }, nameOf)).toBe('Opus would not do this now.')
  })

  it('leaves an agent speaking, and a turn starting, to something else', () => {
    expect(talkPill({ kind: 'asked', agent: 's', to: 'j', text: 'Why?' }, nameOf)).toBeUndefined()
    expect(
      talkPill({ kind: 'answered', agent: 'j', to: ['s'], text: 'Fees.' }, nameOf)
    ).toBeUndefined()
    expect(talkPill({ kind: 'turn', turn: 'ask', agents: ['s'] }, nameOf)).toBeUndefined()
  })
})

describe('talkSpeaker', () => {
  it('says who is speaking to whom', () => {
    expect(talkSpeaker({ kind: 'asked', agent: 's', to: 'j', text: 'Why?' }, nameOf)).toBe(
      'Sonnet to Jeff'
    )
    expect(
      talkSpeaker({ kind: 'answered', agent: 'j', to: ['s', 'o'], text: 'Fees.' }, nameOf)
    ).toBe('Jeff to Sonnet and Opus')
    expect(talkSpeaker({ kind: 'changed', agent: 's' }, nameOf)).toBeUndefined()
  })
})

describe('waitingAgents', () => {
  const nobodyDone = (): boolean => false
  const line = (l: Extract<ThreadItem, { type: 'line' }>['line']): ThreadItem => ({
    type: 'line',
    line: l,
  })

  it('lists agents with no first take and no failure before any turn', () => {
    const items: ThreadItem[] = [{ type: 'take', agent: 's' }]
    expect(waitingAgents(['s', 'j', 'o'], items, (k) => k === 'o')).toEqual(['j'])
  })

  it('lists the agents in the turn who have not spoken', () => {
    const items: ThreadItem[] = [
      { type: 'take', agent: 's' },
      { type: 'take', agent: 'j' },
      line({ kind: 'turn', turn: 'ask', agents: ['s', 'j'] }),
      line({ kind: 'asked', agent: 's', to: 'j', text: 'Why?' }),
    ]
    expect(waitingAgents(['s', 'j'], items, nobodyDone)).toEqual(['j'])
  })

  it('takes the latest turn only', () => {
    const items: ThreadItem[] = [
      { type: 'take', agent: 's' },
      { type: 'take', agent: 'j' },
      line({ kind: 'turn', turn: 'ask', agents: ['s', 'j'] }),
      line({ kind: 'turn', turn: 'answer', agents: ['j'] }),
    ]
    expect(waitingAgents(['s', 'j'], items, nobodyDone)).toEqual(['j'])
  })

  it('removes an agent who answered in the answer turn', () => {
    const items: ThreadItem[] = [
      { type: 'take', agent: 's' },
      { type: 'take', agent: 'j' },
      line({ kind: 'turn', turn: 'answer', agents: ['j'] }),
      line({ kind: 'answered', agent: 'j', to: ['s'], text: 'Fees.' }),
    ]
    expect(waitingAgents(['s', 'j'], items, nobodyDone)).toEqual([])
  })

  it('still lists an agent whose first take is late once a turn has begun', () => {
    const items: ThreadItem[] = [
      { type: 'take', agent: 's' },
      line({ kind: 'turn', turn: 'ask', agents: ['s'] }),
      line({ kind: 'asked', agent: 's', to: 'j', text: 'Why?' }),
    ]
    expect(waitingAgents(['s', 'j'], items, nobodyDone)).toEqual(['j'])
  })
})

describe('showTakes', () => {
  const take: ThreadItem = { type: 'take', agent: 's' }

  it('shows first takes while the race runs', () => {
    expect(showTakes([take], 'competing')).toBe(true)
  })

  it('drops them once decided if nobody talked, since the cards say the same', () => {
    expect(showTakes([take], 'decided')).toBe(false)
    expect(
      showTakes(
        [take, { type: 'line', line: { kind: 'turn', turn: 'ask', agents: ['s'] } }],
        'decided'
      )
    ).toBe(false)
  })

  it('keeps them once decided if anyone talked', () => {
    expect(
      showTakes(
        [take, { type: 'line', line: { kind: 'reading', agent: 's', of: ['j'] } }],
        'decided'
      )
    ).toBe(true)
  })
})

describe('allHeld', () => {
  it('is true only when every agent that answered held off', () => {
    expect(allHeld([{ held: true }, { held: true }, { failed: 'timeout' }])).toBe(true)
    expect(allHeld([{ held: true }, {}])).toBe(false)
    expect(allHeld([{ failed: 'timeout' }])).toBe(false)
    expect(allHeld([])).toBe(false)
  })

  it('tells the person what to do', () => {
    expect(ALL_HELD_LINE).toBe(
      'No agent would do this right now, so there is nothing to sign. Ask again if you still want it.'
    )
  })
})

describe('planTalkReveal', () => {
  it('spaces items 700ms apart', () => {
    expect(planTalkReveal(0, 0)).toBe(700)
    expect(planTalkReveal(1000, 900)).toBe(1700)
  })

  it('never shows an item earlier than now', () => {
    expect(planTalkReveal(1000, 5000)).toBe(5000)
  })

  it('tightens to 150ms once it would pass the close', () => {
    expect(planTalkReveal(19900, 19000)).toBe(20050)
  })
})
