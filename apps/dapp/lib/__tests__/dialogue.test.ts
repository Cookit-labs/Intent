import { describe, expect, it } from 'vitest'

import { rememberExchange } from '../chat/dialogue'

describe('rememberExchange', () => {
  it('appends the message and the reply as one exchange', () => {
    expect(rememberExchange([], 'what can I do?', 'You can swap and send.')).toEqual([
      { role: 'user', content: 'what can I do?' },
      { role: 'assistant', content: 'You can swap and send.' },
    ])
  })

  it('keeps only the most recent four exchanges', () => {
    let d = rememberExchange([], 'm0', 'r0')
    for (let i = 1; i <= 5; i += 1) d = rememberExchange(d, `m${i}`, `r${i}`)
    expect(d).toHaveLength(8)
    expect(d[0]).toEqual({ role: 'user', content: 'm2' })
    expect(d.at(-1)).toEqual({ role: 'assistant', content: 'r5' })
  })

  it('truncates to what the route accepts', () => {
    const d = rememberExchange([], 'x'.repeat(900), 'y'.repeat(900))
    expect(d[0]?.content).toHaveLength(500)
    expect(d[1]?.content).toHaveLength(700)
  })
})
