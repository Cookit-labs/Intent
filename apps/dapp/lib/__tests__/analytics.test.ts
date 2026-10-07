import { beforeEach, describe, expect, it } from 'vitest'

import {
  createAnalyticsRepo,
  executionFromResult,
  failureCode,
  raceRecordFrom,
  type AnalyticsRepo,
} from '../server/analytics'
import { fakeAnalyticsDb, type FakeAnalyticsDb } from './fakes/analytics-db'

/**
 * The analytics log: what Intent records so its usage can be counted and
 * checked later. Small on purpose: no amounts, no prices, no emails, no intent
 * text. What a transaction moved is read from the chain afterwards; the hash
 * here is what lets anyone check it.
 */

const ACCOUNT = 'G'.padEnd(56, 'A')
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

let db: FakeAnalyticsDb
let repo: AnalyticsRepo

beforeEach(() => {
  db = fakeAnalyticsDb()
  repo = createAnalyticsRepo(db.query)
})

describe('recording an execution', () => {
  it('stores the network, wallet, kind, sponsorship and hash', async () => {
    await repo.recordExecution({
      network: 'mainnet',
      account: ACCOUNT,
      kind: 'swap',
      feeSponsored: true,
      ok: true,
      hash: HASH_A,
    })
    expect(db.executions).toHaveLength(1)
    expect(db.executions[0]).toMatchObject({
      network: 'mainnet',
      account: ACCOUNT,
      kind: 'swap',
      fee_sponsored: true,
      ok: true,
      hash: HASH_A,
      failure: null,
    })
  })

  it('records one row for a hash, however many times it is submitted', async () => {
    const row = {
      network: 'testnet' as const,
      account: ACCOUNT,
      kind: 'send' as const,
      feeSponsored: false,
      ok: true,
      hash: HASH_A,
    }
    await repo.recordExecution(row)
    await repo.recordExecution(row)
    expect(db.executions).toHaveLength(1)
  })

  it('keeps the same hash on two networks as two rows', async () => {
    const base = {
      account: ACCOUNT,
      kind: 'swap' as const,
      feeSponsored: false,
      ok: true,
      hash: HASH_A,
    }
    await repo.recordExecution({ ...base, network: 'testnet' })
    await repo.recordExecution({ ...base, network: 'mainnet' })
    expect(db.executions.map((e) => e.network)).toEqual(['testnet', 'mainnet'])
  })

  it('records a refusal that never produced a hash, with its code', async () => {
    await repo.recordExecution({
      network: 'testnet',
      account: ACCOUNT,
      kind: 'swap',
      feeSponsored: false,
      ok: false,
      failure: 'underfunded',
    })
    expect(db.executions[0]).toMatchObject({ ok: false, hash: null, failure: 'underfunded' })
  })

  it('records two hashless refusals as two rows', async () => {
    const row = {
      network: 'testnet' as const,
      account: ACCOUNT,
      kind: 'swap' as const,
      feeSponsored: false,
      ok: false,
      failure: 'rejected',
    }
    await repo.recordExecution(row)
    await repo.recordExecution(row)
    expect(db.executions).toHaveLength(2)
  })
})

describe('reading a submit result', () => {
  it('takes the hash from a success', () => {
    expect(executionFromResult({ ok: true, hash: HASH_A, ledger: 5, explorerUrl: 'x' })).toEqual({
      ok: true,
      hash: HASH_A,
    })
  })

  it('takes the hash and a fixed code from a failure that reached a ledger', () => {
    expect(
      executionFromResult({
        ok: false,
        reason: 'underfunded',
        detail: 'Horizon said x',
        hash: HASH_B,
      })
    ).toEqual({ ok: false, hash: HASH_B, failure: 'underfunded' })
  })

  it('never copies free text from an upstream error', () => {
    const out = executionFromResult({ ok: false, reason: 'network_error', detail: 'secret db url' })
    expect(JSON.stringify(out)).not.toContain('secret')
    expect(out).toEqual({ ok: false, failure: 'network_error' })
  })

  it('accepts the perps shape, which names the failure as a code', () => {
    expect(executionFromResult({ ok: false, code: 'offline', error: 'long text' })).toEqual({
      ok: false,
      failure: 'offline',
    })
  })

  it('falls back to a fixed word when a failure names nothing', () => {
    expect(executionFromResult({ ok: false })).toEqual({ ok: false, failure: 'unknown' })
  })
})

describe('failureCode', () => {
  it('sorts an agent error into a small fixed set', () => {
    expect(failureCode('The operation was aborted due to timeout')).toBe('timeout')
    expect(failureCode('Request failed with status 429 Too Many Requests')).toBe('rate_limited')
    expect(failureCode('401 invalid api key')).toBe('auth')
    expect(failureCode('response was not valid JSON for the tool schema')).toBe('invalid_response')
    expect(failureCode('something else entirely')).toBe('error')
    expect(failureCode(undefined)).toBe('error')
  })
})

describe('recording a race', () => {
  const race = {
    id: '11111111-1111-4111-8111-111111111111',
    network: 'mainnet' as const,
    startedAt: new Date('2026-10-07T10:00:00.000Z'),
    durationMs: 8200,
    intent: { type: 'swap', tokenIn: 'XLM', tokenOut: 'USDC', sizeUsd: 42.5 },
    attempts: [
      {
        agent: 'halcyon',
        model: 'deepseek-chat',
        ok: true as const,
        latencyMs: 4100,
        routeId: 'r1',
        executionMode: 'fill',
      },
      {
        agent: 'orrin',
        model: 'llama',
        ok: false as const,
        latencyMs: 60000,
        error: 'aborted: timeout',
      },
    ],
    scores: { halcyon: 87.5 },
    winner: 'halcyon' as string | null,
    unanimous: false as boolean | null,
  }

  it('stores the race and one row per agent, with a fixed failure code', async () => {
    await repo.recordRace(raceRecordFrom(race))
    expect(db.races).toHaveLength(1)
    expect(db.races[0]).toMatchObject({
      network: 'mainnet',
      intent_type: 'swap',
      token_in: 'XLM',
      token_out: 'USDC',
      size_usd: 42.5,
      agents: 2,
      answered: 1,
      winner: 'halcyon',
      unanimous: false,
      outcome: 'winner',
      duration_ms: 8200,
    })
    expect(db.proposals).toHaveLength(2)
    expect(db.proposals.find((p) => p.agent === 'halcyon')).toMatchObject({
      ok: true,
      won: true,
      score: 87.5,
      latency_ms: 4100,
      route_id: 'r1',
      execution_mode: 'fill',
      failure: null,
    })
    expect(db.proposals.find((p) => p.agent === 'orrin')).toMatchObject({
      ok: false,
      won: false,
      score: null,
      failure: 'timeout',
    })
  })

  it('never stores an agent’s own words', async () => {
    await repo.recordRace(raceRecordFrom(race))
    expect(JSON.stringify([db.races, db.proposals])).not.toContain('aborted')
  })

  it('records a race nobody answered', async () => {
    await repo.recordRace(
      raceRecordFrom({
        ...race,
        attempts: [
          { agent: 'halcyon', model: 'a', ok: false, latencyMs: 10, error: 'timeout' },
          { agent: 'orrin', model: 'b', ok: false, latencyMs: 12, error: 'timeout' },
        ],
        scores: {},
        winner: null,
        unanimous: null,
      })
    )
    expect(db.races[0]).toMatchObject({ outcome: 'no_agent_answered', answered: 0, winner: null })
  })

  it('records a race that was scored but picked no winner', async () => {
    await repo.recordRace(raceRecordFrom({ ...race, winner: null, unanimous: null }))
    expect(db.races[0]?.outcome).toBe('no_winner')
  })

  it('records one race once', async () => {
    await repo.recordRace(raceRecordFrom(race))
    await repo.recordRace(raceRecordFrom(race))
    expect(db.races).toHaveLength(1)
    expect(db.proposals).toHaveLength(2)
  })

  it('leaves the size empty when it is not a number', async () => {
    await repo.recordRace(
      raceRecordFrom({ ...race, intent: { ...race.intent, sizeUsd: Number.NaN } })
    )
    expect(db.races[0]?.size_usd).toBeNull()
  })
})
