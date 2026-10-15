import { describe, expect, it } from 'vitest'

import { fixVerbTypo } from '../chat/typos'

describe('fixVerbTypo', () => {
  it('corrects a verb one edit away', () => {
    expect(fixVerbTypo('edge 5 USDC exposure')).toBe('hedge 5 USDC exposure')
    expect(fixVerbTypo('Swpa 5 XLM to USDC')).toBe('Swpa 5 XLM to USDC')
    expect(fixVerbTypo('swop 5 XLM to USDC')).toBe('swap 5 XLM to USDC')
    expect(fixVerbTypo('Hedg 5 USDC')).toBe('Hedge 5 USDC')
  })

  it('leaves real verbs, real words and far misses alone', () => {
    expect(fixVerbTypo('swap 5 XLM to USDC')).toBe('swap 5 XLM to USDC')
    expect(fixVerbTypo('sale of 5 XLM')).toBe('sale of 5 XLM')
    expect(fixVerbTypo('what is XLM')).toBe('what is XLM')
  })
})
