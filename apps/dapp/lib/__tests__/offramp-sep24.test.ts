import { describe, expect, it } from 'vitest'

import type { AnchorToml } from '../offramp/toml'
import {
  isDeclined,
  isReadyToPay,
  isSettledByAnchor,
  isWaitingOnAnchor,
  readTransaction,
  readWithdrawInfo,
  startWithdraw,
} from '../offramp/sep24'

/**
 * The SEP-24 calls. Every response shape here was transcribed from the spec
 * and checked against testanchor's live answers on 2026-09-18; the field names
 * are the anchor's, so `withdraw_anchor_account` stays snake_case at the wire
 * and becomes `withdrawAnchorAccount` here.
 */

const TOML: AnchorToml = {
  transferServerSep24: 'https://testanchor.stellar.org/sep24',
  webAuthEndpoint: 'https://testanchor.stellar.org/auth',
  signingKey: 'GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR',
  networkPassphrase: 'Test SDF Network ; September 2015',
}

interface Seen {
  url: string
  init: RequestInit | undefined
}

function answering(payload: unknown, seen: Seen[] = [], status = 200): typeof fetch {
  return ((url: string, init?: RequestInit) => {
    seen.push({ url, init })
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  }) as unknown as typeof fetch
}

/** testanchor's real /info, captured live. */
const INFO = {
  deposit: { USDC: { enabled: true, min_amount: 1, max_amount: 10 } },
  withdraw: {
    USDC: { enabled: true, min_amount: 1, max_amount: 10 },
    SRT: { enabled: true },
  },
  fee: { enabled: false },
}

describe('readWithdrawInfo', () => {
  it('reads the limits for the asset', async () => {
    const limits = await readWithdrawInfo(TOML, 'USDC', answering(INFO))
    expect(limits).toEqual({ enabled: true, minAmount: 1, maxAmount: 10, feeEnabled: false })
  })

  it('leaves absent limits absent', async () => {
    const limits = await readWithdrawInfo(TOML, 'SRT', answering(INFO))
    expect(limits).toEqual({ enabled: true, feeEnabled: false })
  })

  it('returns nothing for an asset the anchor does not withdraw', async () => {
    expect(await readWithdrawInfo(TOML, 'XLM', answering(INFO))).toBeUndefined()
  })

  it('hits /info under the transfer server', async () => {
    const seen: Seen[] = []
    await readWithdrawInfo(TOML, 'USDC', answering(INFO, seen))
    expect(seen[0]?.url).toBe('https://testanchor.stellar.org/sep24/info')
  })
})

describe('startWithdraw', () => {
  it('posts the asset and amount with the bearer token and returns id and url', async () => {
    const seen: Seen[] = []
    const started = await startWithdraw(
      TOML,
      { authToken: 'jwt-1', assetCode: 'USDC', amount: '5' },
      answering(
        { type: 'interactive_customer_info_needed', url: 'https://a/kyc', id: 'tx-1' },
        seen
      )
    )
    expect(started).toEqual({ id: 'tx-1', url: 'https://a/kyc' })
    expect(seen[0]?.url).toBe(
      'https://testanchor.stellar.org/sep24/transactions/withdraw/interactive'
    )
    const headers = seen[0]?.init?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer jwt-1')
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ asset_code: 'USDC', amount: '5' })
  })

  it('omits amount when none was given', async () => {
    const seen: Seen[] = []
    await startWithdraw(
      TOML,
      { authToken: 'jwt-1', assetCode: 'USDC' },
      answering({ type: 'interactive_customer_info_needed', url: 'https://a', id: 'x' }, seen)
    )
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ asset_code: 'USDC' })
  })

  it('refuses a response that is not the interactive type', async () => {
    await expect(
      startWithdraw(
        TOML,
        { authToken: 'jwt', assetCode: 'USDC' },
        answering({ type: 'non_interactive_customer_info_needed', fields: [] })
      )
    ).rejects.toThrow(/interactive/)
  })

  it('surfaces an anchor error message', async () => {
    await expect(
      startWithdraw(
        TOML,
        { authToken: 'jwt', assetCode: 'USDC' },
        answering({ error: 'asset not supported' }, [], 400)
      )
    ).rejects.toThrow(/asset not supported/)
  })
})

describe('readTransaction', () => {
  const READY = {
    transaction: {
      id: 'tx-1',
      kind: 'withdrawal',
      status: 'pending_user_transfer_start',
      withdraw_anchor_account: 'GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR',
      withdraw_memo: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      withdraw_memo_type: 'hash',
      amount_in: '5.0000000',
      amount_out: '4.90',
      amount_in_asset: 'stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      more_info_url: 'https://testanchor.stellar.org/sep24/transaction/more_info?id=tx-1',
      kyc_verified: true,
    },
  }

  it('maps the wire fields to the app shape', async () => {
    const seen: Seen[] = []
    const tx = await readTransaction(TOML, { authToken: 'jwt', id: 'tx-1' }, answering(READY, seen))
    expect(seen[0]?.url).toBe('https://testanchor.stellar.org/sep24/transaction?id=tx-1')
    expect(tx.status).toBe('pending_user_transfer_start')
    expect(tx.withdrawAnchorAccount).toBe(
      'GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR'
    )
    expect(tx.withdrawMemo).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')
    expect(tx.withdrawMemoType).toBe('hash')
    expect(tx.amountIn).toBe('5.0000000')
    expect(tx.moreInfoUrl).toMatch(/more_info/)
  })

  it('refuses a status it does not know', async () => {
    const odd = { transaction: { ...READY.transaction, status: 'pending_moon' } }
    await expect(
      readTransaction(TOML, { authToken: 'jwt', id: 'x' }, answering(odd))
    ).rejects.toThrow(/pending_moon/)
  })

  it('refuses a memo type it does not know', async () => {
    const odd = { transaction: { ...READY.transaction, withdraw_memo_type: 'return' } }
    await expect(
      readTransaction(TOML, { authToken: 'jwt', id: 'x' }, answering(odd))
    ).rejects.toThrow(/memo type/)
  })

  it('refuses a 401 plainly, so the caller re-authenticates rather than retries', async () => {
    await expect(
      readTransaction(
        TOML,
        { authToken: 'stale', id: 'x' },
        answering({ error: 'unauthorized' }, [], 401)
      )
    ).rejects.toThrow(/401/)
  })
})

describe('status classification', () => {
  it('is ready to pay only at pending_user_transfer_start', () => {
    expect(isReadyToPay('pending_user_transfer_start')).toBe(true)
    expect(isReadyToPay('incomplete')).toBe(false)
    expect(isReadyToPay('pending_user_transfer_complete')).toBe(false)
    expect(isReadyToPay('completed')).toBe(false)
  })

  it('names the states in which nothing should ever be sent', () => {
    for (const s of [
      'expired',
      'refunded',
      'error',
      'no_market',
      'too_small',
      'too_large',
    ] as const) {
      expect(isDeclined(s)).toBe(true)
      expect(isReadyToPay(s)).toBe(false)
    }
  })

  it('treats on_hold and every other pending state as waiting, not failing', () => {
    for (const s of [
      'incomplete',
      'pending_anchor',
      'pending_external',
      'pending_stellar',
      'pending_user',
      'pending_trust',
      'pending_user_transfer_complete',
      'on_hold',
    ] as const) {
      expect(isWaitingOnAnchor(s)).toBe(true)
      expect(isDeclined(s)).toBe(false)
    }
  })

  it('knows completed', () => {
    expect(isSettledByAnchor('completed')).toBe(true)
    expect(isWaitingOnAnchor('completed')).toBe(false)
  })
})
