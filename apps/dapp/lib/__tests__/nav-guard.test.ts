import { describe, expect, it } from 'vitest'

import { createNavGuard } from '../nav-guard'

describe('createNavGuard', () => {
  it('follows the first click and ignores repeats while it is pending', () => {
    const guard = createNavGuard()
    expect(guard.follow('/sui/apps')).toBe(true)
    expect(guard.follow('/sui/apps')).toBe(false)
    expect(guard.follow('/sui/apps')).toBe(false)
  })

  it('lets a different destination take over', () => {
    const guard = createNavGuard()
    expect(guard.follow('/sui/apps')).toBe(true)
    expect(guard.follow('/sui/agents')).toBe(true)
    expect(guard.follow('/sui/apps')).toBe(true)
  })

  it('allows the same link again once the navigation settled', () => {
    const guard = createNavGuard()
    guard.follow('/sui/apps')
    guard.settle()
    expect(guard.follow('/sui/apps')).toBe(true)
  })

  it('does not leave a link dead if a navigation never finishes', () => {
    let now = 0
    const guard = createNavGuard(60_000, () => now)
    guard.follow('/sui/apps')
    now = 59_999
    expect(guard.follow('/sui/apps')).toBe(false)
    now = 60_000
    expect(guard.follow('/sui/apps')).toBe(true)
  })
})
