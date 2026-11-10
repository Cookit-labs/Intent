import { describe, expect, it } from 'vitest'

import { yieldReply } from '../chat/yield-reply'

describe('yieldReply', () => {
  it('names the venue paying the most first, then the others, highest first', () => {
    const text = yieldReply({
      asset: 'USDC',
      chainName: 'Solana',
      rates: [
        { venueName: 'Save', apyPercent: 4.1 },
        { venueName: 'Kamino Lend', apyPercent: 6.123 },
        { venueName: 'Jupiter Lend', apyPercent: 5.4 },
      ],
    })
    expect(text).toContain('Right now on Solana, USDC earns the most on Kamino Lend: 6.12% a year.')
    expect(text).toContain('Other live rates: Jupiter Lend 5.40%, Save 4.10%.')
    expect(text).toContain('"supply my USDC to Kamino Lend"')
    expect(text).toMatch(/isn't a promise/)
    expect(text).not.toMatch(/[—–]/)
  })

  it('leaves out the list of others when there is only one', () => {
    const text = yieldReply({
      asset: 'XLM',
      chainName: 'Stellar',
      rates: [{ venueName: 'Blend', apyPercent: 0.71 }],
    })
    expect(text).toContain('XLM earns the most on Blend: 0.71% a year.')
    expect(text).not.toContain('Other live rates')
  })

  it('refuses to guess when no rate could be read', () => {
    expect(yieldReply({ asset: 'USDC', chainName: 'Sui', rates: [] })).toBe(
      "I couldn't read a live USDC rate on Sui just now, so I won't guess. Try again in a moment."
    )
  })

  it('drops rates that are not real numbers', () => {
    const text = yieldReply({
      asset: 'USDC',
      chainName: 'NEAR',
      rates: [
        { venueName: 'Broken', apyPercent: Number.NaN },
        { venueName: 'Rhea Lending', apyPercent: 3.2 },
      ],
    })
    expect(text).toContain('USDC earns the most on Rhea Lending: 3.20% a year.')
    expect(text).not.toContain('Broken')
  })
})
