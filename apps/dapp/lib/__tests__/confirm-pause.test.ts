import { describe, expect, it } from 'vitest'

import { confirmPauseUsd, needsConfirmPause } from '../swap/confirm-pause'

describe('confirmPauseUsd', () => {
  it('is undefined when neither side is priced', () => {
    expect(confirmPauseUsd(undefined, undefined)).toBeUndefined()
  })

  it('takes the larger side when only one is priced', () => {
    expect(confirmPauseUsd(500, undefined)).toBe(500)
    expect(confirmPauseUsd(undefined, 500)).toBe(500)
  })

  it('takes the larger of the two sides, not their sum', () => {
    expect(confirmPauseUsd(100, 900)).toBe(900)
    expect(confirmPauseUsd(900, 100)).toBe(900)
  })
})

describe('needsConfirmPause', () => {
  it('is false when there is nothing to compare', () => {
    expect(needsConfirmPause(undefined, 500)).toBe(false)
  })

  it('is false under the threshold and true at or above it', () => {
    expect(needsConfirmPause(499.99, 500)).toBe(false)
    expect(needsConfirmPause(500, 500)).toBe(true)
    expect(needsConfirmPause(501, 500)).toBe(true)
  })
})
