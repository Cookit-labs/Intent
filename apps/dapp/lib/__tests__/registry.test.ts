import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Which brain answers, and — more importantly — what happens when none can.
 *
 * A mock brain used to stand in for a missing key, so a misconfigured
 * deployment ran four agents reciting canned text. The registry now returns
 * nothing, and the route turns nothing into a message the user reads.
 *
 * Modules are reset between cases because the DeepSeek brain reads its key
 * once, at load. A registry imported fresh over a stale brain would report
 * the environment as it was the first time, not as it is now.
 */

const KEY = 'DEEPSEEK_API_KEY'

describe('getAgentBrain', () => {
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env[KEY]
    vi.resetModules()
  })

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY]
    else process.env[KEY] = saved
    vi.resetModules()
  })

  it('returns nothing rather than a stand-in when no key is configured', async () => {
    delete process.env[KEY]
    const { getAgentBrain } = await import('../agents/registry')
    expect(getAgentBrain()).toBeUndefined()
  })

  it('returns the live brain when a key is configured', async () => {
    process.env[KEY] = 'test-key'
    const { getAgentBrain } = await import('../agents/registry')
    expect(getAgentBrain()?.id).toBe('deepseek')
  })
})
