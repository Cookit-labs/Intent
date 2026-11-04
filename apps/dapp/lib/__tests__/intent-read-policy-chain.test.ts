import { describe, expect, it } from 'vitest'

import { chainReadPolicy } from '../intent-read-policy'
import { readingFromArguments } from '../parse-intent-llm'

const args = (over: Record<string, unknown> = {}) => ({
  action: 'swap',
  tokenIn: 'SOL',
  tokenOut: 'USDC',
  amountUsd: 5,
  amountIsUsd: false,
  amountStated: true,
  followOn: 'none',
  followOnVenue: '',
  ...over,
})

describe('chainReadPolicy', () => {
  it('has nothing for Stellar or a chain with no module', () => {
    expect(chainReadPolicy('stellar')).toBeUndefined()
    expect(chainReadPolicy('arc')).toBeUndefined()
  })

  it("allows the chain's own tokens, native, name words and mixed-case symbols, upper-cased", () => {
    const solana = chainReadPolicy('solana')
    expect(solana?.symbols).toEqual(expect.arrayContaining(['SOL', 'USDC', 'SOLANA', 'JITOSOL']))
    expect(solana?.symbols).not.toContain('XLM')
    expect(chainReadPolicy('sui')?.symbols).not.toContain('SOL')
    expect(chainReadPolicy('avalanche')?.symbols).toEqual(
      expect.arrayContaining(['AVAX', 'AVALANCHE'])
    )
  })

  it('accepts "change my 5 sol into kes" as a SOL to USDC cash-out on Solana', () => {
    const policy = chainReadPolicy('solana')
    const read = readingFromArguments(args({ followOn: 'offramp' }), {
      allowedSymbols: policy?.symbols as string[],
      allowedVenues: policy?.venues as string[],
      allowedAnchors: ['weave'],
    })
    expect(read).toMatchObject({
      tokenIn: 'SOL',
      tokenOut: 'USDC',
      amountUsd: 5,
      amountStated: true,
      followOn: { kind: 'offramp', venue: 'weave' },
    })
  })

  it('refuses SOL on Sui, and a stated amount of zero stays unreadable', () => {
    const sui = chainReadPolicy('sui')
    expect(readingFromArguments(args(), { allowedSymbols: sui?.symbols as string[] })).toBeNull()
    const solana = chainReadPolicy('solana')
    expect(
      readingFromArguments(args({ amountUsd: 0 }), { allowedSymbols: solana?.symbols as string[] })
    ).toBeNull()
  })

  it('offers deposit venues from the module and no Stellar ones', () => {
    expect(chainReadPolicy('solana')?.venues.length).toBeGreaterThan(0)
    expect(chainReadPolicy('solana')?.venues).not.toContain('blend')
  })
})
