// apps/dapp/lib/__tests__/offramp-read-expectation.test.ts
import { describe, expect, it } from 'vitest'

import { readExpectation } from '../offramp/read-expectation'

/**
 * One reader for both routes, so build and submit cannot disagree about what
 * "ready" means. Every non-ready outcome is a code the client can act on:
 * `not_ready` means keep polling, `declined` means stop and say so, and the
 * rest are configuration or network.
 */

const TOML = `
NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
TRANSFER_SERVER_SEP0024 = "https://testanchor.stellar.org/sep24"
WEB_AUTH_ENDPOINT = "https://testanchor.stellar.org/auth"
SIGNING_KEY = "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR"
`

function anchorAnswering(status: string, extra: Record<string, unknown> = {}): typeof fetch {
  return ((url: string) => {
    if (url.endsWith('stellar.toml')) return Promise.resolve(new Response(TOML))
    return Promise.resolve(
      new Response(
        JSON.stringify({
          transaction: {
            id: 'tx-1',
            kind: 'withdrawal',
            status,
            withdraw_anchor_account: 'GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR',
            withdraw_memo: Buffer.alloc(32, 1).toString('base64'),
            withdraw_memo_type: 'hash',
            amount_in: '5',
            ...extra,
          },
        })
      )
    )
  }) as unknown as typeof fetch
}

const REQ = { anchorId: 'testanchor', transactionId: 'tx-1', authToken: 'jwt' }

describe('readExpectation', () => {
  it('returns an expectation for a ready transaction', async () => {
    const r = await readExpectation({
      ...REQ,
      fetchImpl: anchorAnswering('pending_user_transfer_start'),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.expectation.amount).toBe('5')
    expect(r.expectation.transactionId).toBe('tx-1')
  })

  it('reports not_ready with the status while the anchor is still working', async () => {
    const r = await readExpectation({ ...REQ, fetchImpl: anchorAnswering('incomplete') })
    expect(r).toMatchObject({ ok: false, code: 'not_ready', status: 'incomplete' })
  })

  it('reports declined when the anchor gave up', async () => {
    const r = await readExpectation({ ...REQ, fetchImpl: anchorAnswering('expired') })
    expect(r).toMatchObject({ ok: false, code: 'declined', status: 'expired' })
  })

  it('reports unusable when a ready transaction lacks a field', async () => {
    const r = await readExpectation({
      ...REQ,
      fetchImpl: anchorAnswering('pending_user_transfer_start', { withdraw_memo: undefined }),
    })
    expect(r).toMatchObject({ ok: false, code: 'unusable' })
  })

  it('refuses an anchor not on the list', async () => {
    const r = await readExpectation({
      ...REQ,
      anchorId: 'binance',
      fetchImpl: anchorAnswering('x'),
    })
    expect(r).toMatchObject({ ok: false, code: 'unknown_anchor' })
  })

  it('reports an unreachable anchor', async () => {
    const down = (() =>
      Promise.resolve(new Response('', { status: 503 }))) as unknown as typeof fetch
    const r = await readExpectation({ ...REQ, fetchImpl: down })
    expect(r).toMatchObject({ ok: false, code: 'anchor_unreachable' })
  })
})
