import { describe, expect, it } from 'vitest'

import { timeAgo } from '../wallet/time-ago'

const NOW = new Date('2026-10-05T12:00:00Z')

describe('timeAgo', () => {
  it('says just now inside a minute', () => {
    expect(timeAgo('2026-10-05T11:59:40Z', NOW)).toBe('just now')
  })

  it('counts minutes, hours and days', () => {
    expect(timeAgo('2026-10-05T11:55:00Z', NOW)).toBe('5 min ago')
    expect(timeAgo('2026-10-05T09:00:00Z', NOW)).toBe('3 h ago')
    expect(timeAgo('2026-10-03T12:00:00Z', NOW)).toBe('2 d ago')
  })

  it('switches to a date after a week', () => {
    expect(timeAgo('2026-09-01T12:00:00Z', NOW)).toBe('1 Sep')
  })

  it('treats a time slightly in the future as just now', () => {
    expect(timeAgo('2026-10-05T12:00:30Z', NOW)).toBe('just now')
  })
})
