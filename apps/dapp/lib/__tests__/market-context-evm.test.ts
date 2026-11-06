import { describe, expect, it, vi } from 'vitest'

import { buildMarketContext } from '../agents/market-context'

// Neither 1Click row claims execution today, so the family filter alone would pass by accident.
// A row that does claim it shows that one EVM chain is never handed another's venue.
vi.mock('../venues', async (original) => {
  const actual = await original<typeof import('../venues')>()
  const row = (id: string, chain: string) => ({
    id,
    family: 'evm' as const,
    name: id,
    category: 'swap' as const,
    chains: [chain],
    url: 'https://example.test',
    bestFor: 'x',
    integration: 'executes' as const,
  })
  return {
    ...actual,
    venues: [...actual.venues, row('on-avalanche', 'Avalanche'), row('on-monad', 'Monad')],
  }
})

describe('the market on EVM chains that share a family', () => {
  it('gives each chain only the venues that name it', () => {
    const ids = (chain: string): string[] =>
      buildMarketContext(chain, {}, 'mainnet').venues.map((v) => v.id)
    expect(ids('avalanche')).toContain('on-avalanche')
    expect(ids('avalanche')).toContain('cow-limit')
    expect(ids('avalanche')).not.toContain('on-monad')
    expect(ids('avalanche')).not.toContain('aave-monad')
    expect(ids('monad')).toContain('on-monad')
    expect(ids('monad')).not.toContain('cow-limit')
    expect(ids('monad')).not.toContain('on-avalanche')
    expect(ids('monad')).not.toContain('aave-avalanche')
  })
})
