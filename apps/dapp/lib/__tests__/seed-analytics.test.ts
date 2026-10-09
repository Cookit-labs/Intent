import { describe, expect, it } from 'vitest'

import { SEED_PREFIX, buildSeed } from '../dev/seed-analytics'

const now = new Date('2026-10-09T12:00:00.000Z')

describe('the analytics seed', () => {
  it('gives the same rows for the same inputs', () => {
    const a = buildSeed({ network: 'testnet', days: 30, now })
    const b = buildSeed({ network: 'testnet', days: 30, now })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.executions.length).toBeGreaterThan(30)
  })

  it('marks every row so it can be told apart and removed', () => {
    const seed = buildSeed({ network: 'testnet', days: 30, now })
    const ids = [...seed.executions, ...seed.races, ...seed.reads].map((r) => r.id)
    expect(ids.every((id) => id.startsWith(SEED_PREFIX))).toBe(true)
    expect(ids.every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('stays on the network asked for', () => {
    const seed = buildSeed({ network: 'mainnet', days: 10, now })
    const networks = new Set(
      [...seed.executions, ...seed.races, ...seed.reads].map((r) => r.network)
    )
    expect([...networks]).toEqual(['mainnet'])
  })

  it('never reaches into the future, nor beyond the days asked for', () => {
    const seed = buildSeed({ network: 'testnet', days: 14, now })
    const times = [...seed.executions, ...seed.races, ...seed.reads].map((r) => r.at.getTime())
    expect(Math.max(...times)).toBeLessThanOrEqual(now.getTime())
    expect(Math.min(...times)).toBeGreaterThanOrEqual(Date.UTC(2026, 9, 9 - 13))
  })

  it('looks like real usage: mostly successes, some failures and unpriced rows', () => {
    const { executions } = buildSeed({ network: 'testnet', days: 60, now })
    const ok = executions.filter((e) => e.ok)
    expect(ok.length / executions.length).toBeGreaterThan(0.8)
    expect(executions.some((e) => !e.ok && e.failure !== null)).toBe(true)
    expect(ok.some((e) => e.volumeUsd === null)).toBe(true)
    expect(ok.every((e) => e.amountIn !== null && e.assetIn !== null)).toBe(true)
    expect(executions.every((e) => /^[0-9a-f]{64}$/.test(e.hash))).toBe(true)
    expect(executions.every((e) => e.account.length === 56)).toBe(true)
  })

  it('names a winner only among agents that answered, and at most one', () => {
    for (const race of buildSeed({ network: 'testnet', days: 30, now }).races) {
      const won = race.proposals.filter((p) => p.won)
      expect(won.length).toBeLessThanOrEqual(1)
      expect(won.every((p) => p.ok)).toBe(true)
      expect(race.answered).toBe(race.proposals.filter((p) => p.ok).length)
      expect(race.winner).toBe(won[0]?.agent ?? null)
    }
  })
})
