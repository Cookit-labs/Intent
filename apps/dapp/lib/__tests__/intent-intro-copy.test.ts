import { describe, expect, it } from 'vitest'

import { intentIntro } from '../intent-intro-copy'

describe('intentIntro', () => {
  it('says USDC on Arc only for Arc', () => {
    expect(intentIntro('arc')).toContain('USDC on Arc')
  })

  it('names Stellar, and never Arc, on the Stellar chain', () => {
    const text = intentIntro('stellar')
    expect(text).toContain('Stellar')
    expect(text).not.toMatch(/Arc/)
  })
})
