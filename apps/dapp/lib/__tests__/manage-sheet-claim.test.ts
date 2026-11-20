import { describe, expect, it } from 'vitest'

import { onlyWhole } from '../../components/intents/position-card'

const move = { label: 'Withdraw', onAmount: () => {} }
const all = { label: 'Claim', onPress: () => {} }

describe('onlyWhole', () => {
  it('is true for a claim, which has no amount to choose', () => {
    expect(onlyWhole({ all })).toBe(true)
  })

  it('is false wherever an amount can be typed', () => {
    expect(onlyWhole({ out: move, all })).toBe(false)
    expect(onlyWhole({ into: move, all })).toBe(false)
    expect(onlyWhole({ out: move })).toBe(false)
  })

  it('is false with nothing to do', () => {
    expect(onlyWhole({})).toBe(false)
  })
})
