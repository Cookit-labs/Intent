import { createHash } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { capabilitySheet } from '../orchestrate/capabilities'
import { orchestrateWithLlm } from '../orchestrate/orchestrate'

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
    expect(sheet).not.toMatch(/Accumulate|Hedge|limit order/)
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
    expect(lines).toHaveLength(5)
  })
})

describe('capabilitySheet multi-step forms', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  async function sheetWith(weave: string): Promise<typeof capabilitySheet> {
    vi.resetModules()
    vi.stubEnv('AUTH_SECRET', 'x'.repeat(48))
    vi.stubEnv('WEAVE_SECRET_KEY', weave)
    return (await import('../orchestrate/capabilities')).capabilitySheet
  }

  it('says swap then cash out runs on Solana, Sui and Avalanche', async () => {
    const sheet = await sheetWith('k')
    for (const chain of ['solana', 'sui', 'avalanche']) {
      expect(sheet(chain)).toMatch(/Swap then cash out:/)
    }
    expect(sheet('solana')).toMatch(/Swap then deposit:/)
    expect(sheet('solana')).toMatch(/Swap then send:/)
  }, 60_000)

  it('promises no cash-out where Weave is not set up', async () => {
    const sheet = await sheetWith('')
    expect(sheet('solana')).not.toMatch(/cash out/i)
  }, 60_000)

  it('says NEAR runs swap then deposit and send, and why cash-out and stake do not', async () => {
    const sheet = await sheetWith('k')
    const near = sheet('near')
    expect(near).toMatch(/Swap then deposit:/)
    expect(near).toMatch(/Swap then send:/)
    expect(near).not.toMatch(/Swap then cash out:/)
    expect(near).toContain("Weave's NEAR deposits aren't working yet")
    expect(near).toMatch(/stake after a swap is not available on NEAR/i)
  }, 60_000)

  it('says Monad runs swap and send, and not cash-out or deposit', async () => {
    const sheet = await sheetWith('k')
    const monad = sheet('monad')
    expect(monad).toMatch(/Swap then send:/)
    expect(monad).not.toMatch(/Swap then (cash out|deposit):/)
    expect(monad).toMatch(/Cash out and deposit after a swap do not run on Monad/)
  }, 60_000)

  it('says which native coins cannot be sent yet', async () => {
    const sheet = await sheetWith('k')
    expect(sheet('solana')).toContain("Native SOL can't be sent yet")
    expect(sheet('sui')).toContain("Native SUI can't be sent yet")
    expect(sheet('near')).toContain("Native NEAR can't be sent yet")
    expect(sheet('avalanche')).not.toContain("can't be sent yet")
  }, 60_000)

  it('keeps limit orders listed as not available, and lists every token in a balance', async () => {
    const sheet = await sheetWith('k')
    for (const chain of ['solana', 'sui', 'near', 'avalanche', 'monad']) {
      expect(sheet(chain)).toContain('Limit orders are not available off Stellar')
      expect(sheet(chain)).toMatch(/Balance:.*every token/)
    }
  }, 60_000)

  it('promises no send without the secret that issues it', async () => {
    vi.resetModules()
    vi.stubEnv('AUTH_SECRET', '')
    vi.stubEnv('WEAVE_SECRET_KEY', 'k')
    const { capabilitySheet: sheet } = await import('../orchestrate/capabilities')
    expect(sheet('solana')).not.toMatch(/Send:|then send/)
    expect(sheet('near')).not.toMatch(/Send:|then send/)
  }, 60_000)
})

describe('the orchestrator prompt', () => {
  afterEach(() => vi.unstubAllEnvs())

  async function systemFor(chain: string): Promise<string> {
    let system = ''
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      system = (JSON.parse(init.body) as { messages: { content: string }[] }).messages[0]
        ?.content as string
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    await orchestrateWithLlm([{ role: 'user', content: 'hi' }], {
      apiKey: 'k',
      chain,
      fetchImpl,
    })
    return system
  }

  it('is byte for byte what it was on Stellar', async () => {
    vi.stubEnv('WEAVE_SECRET_KEY', '')
    const system = await systemFor('stellar')
    expect(system.length).toBe(6270)
    expect(createHash('sha256').update(system).digest('hex')).toBe(
      '06762643ae6b219a91581fc48e65b67563bb70062f2761e60a8a5d3aeae9be1b'
    )
  })

  it('says off Stellar what is true there about follow-ons', async () => {
    const system = await systemFor('solana')
    expect(system).toMatch(/not on Stellar/)
    expect(system).toMatch(/character for character/)
    expect(system).toMatch(/Swap 5 SOL to USDC, then send to/)
  })
})
