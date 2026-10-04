import { describe, expect, it } from 'vitest'

import { constantTimeEqual } from '../server/constant-time-equal'
import { SESSION_TTL_SECONDS } from '../server/session-constants'

describe('constantTimeEqual', () => {
  it('is true for identical strings', () => {
    expect(constantTimeEqual('abc-DEF_123', 'abc-DEF_123')).toBe(true)
  })

  it('is false when one character differs, at any position', () => {
    expect(constantTimeEqual('abcdef', 'abcdeX')).toBe(false)
    expect(constantTimeEqual('abcdef', 'Xbcdef')).toBe(false)
  })

  it('is false when the lengths differ', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
    expect(constantTimeEqual('', 'a')).toBe(false)
  })
})

describe('session lifetime', () => {
  it('is at most one day, so a removed tester loses access within a day', () => {
    expect(SESSION_TTL_SECONDS).toBeLessThanOrEqual(24 * 60 * 60)
  })
})
