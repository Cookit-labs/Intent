import { describe, expect, it } from 'vitest'

import { tidyProse } from '../chat/prose'

describe('tidyProse', () => {
  it('turns a spaced em dash into a sentence break', () => {
    expect(tidyProse("Intent doesn't do stocks — it works with crypto.")).toBe(
      "Intent doesn't do stocks. It works with crypto."
    )
  })

  it('handles an unspaced em dash and a spaced en dash', () => {
    expect(tidyProse('fees—small ones')).toBe('fees, small ones')
    expect(tidyProse('Swap first – then pay out')).toBe('Swap first. Then pay out')
  })

  it('keeps an en dash in a range', () => {
    expect(tidyProse('Rates of 3–5% apply')).toBe('Rates of 3–5% apply')
  })

  it('keeps paragraphs and turns list markers into bullets', () => {
    expect(tidyProse('You can:\n- swap\n* lend\n\n\n\nThat is all.')).toBe(
      'You can:\n• swap\n• lend\n\nThat is all.'
    )
  })
})
