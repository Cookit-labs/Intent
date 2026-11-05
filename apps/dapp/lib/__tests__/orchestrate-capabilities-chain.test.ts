import { afterEach, describe, expect, it, vi } from 'vitest'

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

  it('leaves a chain with no module as it was', () => {
    expect(capabilitySheet('arc')).toBe(
      '- Swap: trade one asset for another at the market price. You review it and sign in your wallet.'
    )
  })
})

describe('capabilitySheet reads what the chain can run on this server', () => {
  afterEach(() => {
    vi.doUnmock('../chains/registry')
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  /** The real registry, built from scratch with this secret, as a server starting up would. */
  async function sheetWith(secret: string): Promise<typeof capabilitySheet> {
    vi.resetModules()
    vi.stubEnv('AUTH_SECRET', secret)
    return (await import('../orchestrate/capabilities')).capabilitySheet
  }

  it('promises nothing on Avalanche and Monad with no secret to issue a deposit', async () => {
    const sheet = await sheetWith('')
    for (const chain of ['avalanche', 'monad']) {
      expect(sheet(chain)).toBe(
        '- Nothing can be swapped, supplied or staked on this chain right now.'
      )
    }
  })

  it('promises the race on them once the secret is set', async () => {
    const sheet = await sheetWith('x'.repeat(48))
    for (const chain of ['avalanche', 'monad']) {
      expect(sheet(chain)).toContain('Swap:')
      expect(sheet(chain)).toContain('Agents compete')
      expect(sheet(chain)).not.toMatch(/Supply:|Stake:/)
    }
  }, 60_000)

  it('still races Solana and Sui with no secret, on their own venues', async () => {
    const sheet = await sheetWith('')
    expect(sheet('solana')).toMatch(/Swap:.*Agents compete/)
    expect(sheet('sui')).toMatch(/Swap:.*Agents compete/)
  }, 60_000)

  it('promises no race for a venue that gives no quote, and says the rest plainly', async () => {
    vi.resetModules()
    vi.doMock('../chains/registry', () => ({
      chainModule: () => ({ venues: [{ kinds: ['swap'] }, { kinds: ['stake'], quote: vi.fn() }] }),
    }))
    const { capabilitySheet: sheet } = await import('../orchestrate/capabilities')
    const lines = sheet('near').split(/\r?\n/)
    expect(lines[0]).toMatch(/^- Swap:.*You review it/)
    expect(lines[0]).not.toContain('Agents compete')
    expect(lines[1]).toMatch(/^- Stake:.*Agents compete/)
    expect(lines).toHaveLength(2)
  })
})
