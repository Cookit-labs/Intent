import { describe, expect, it } from 'vitest'

import { capabilitySheet } from '../orchestrate/capabilities'

describe('capabilitySheet per chain', () => {
  it('keeps Stellar as it was', () => {
    const sheet = capabilitySheet('stellar')
    expect(sheet).toContain('limit order')
    expect(sheet).toContain('Accumulate')
    expect(sheet).toContain('Send:')
  })

  it('says agents compete on NEAR and lists what NEAR can do', () => {
    const sheet = capabilitySheet('near')
    expect(sheet).toContain('Agents compete')
    expect(sheet).toContain('Supply:')
    expect(sheet).toContain('Stake:')
    expect(sheet).not.toMatch(/Send:|Accumulate|Hedge|limit order/)
  })

  it('says agents compete on Solana and Sui now their venues can be quoted', () => {
    expect(capabilitySheet('solana')).toContain('Agents compete')
    expect(capabilitySheet('sui')).toContain('Agents compete')
    expect(capabilitySheet('solana')).not.toContain('Stake:')
  })
})
