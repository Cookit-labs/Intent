import { describe, expect, it, vi } from 'vitest'

import {
  accountMismatch,
  afterSigning,
  afterSubmitting,
  latchBeforeSign,
} from '../chains/signing-flow'
import { panelErrorMessage, reviewChainRoute } from '../agents/chain-race'
import type { ChainActionRequest } from '../chains/types'
import { CHECK_WALLET } from '../weave/cashout-view'

const asked: ChainActionRequest = { kind: 'swap', amount: '5', tokenIn: 'NEAR', tokenOut: 'USDC' }
const route = {
  kind: 'chain',
  request: asked,
  venueId: 'ref',
  venueName: 'Ref',
  pay: { amount: '5', symbol: 'NEAR' },
}

function review(phase: Parameters<typeof reviewChainRoute>[0]['phase'], signed: boolean) {
  const prepare = vi.fn()
  const outcome = reviewChainRoute({
    route,
    asked,
    text: 't',
    phase,
    signed,
    prepare,
    refuse: vi.fn(),
  })
  return { outcome, prepare }
}

describe('the latch before the wallet is called', () => {
  it('is set for wallets that send for themselves', () => {
    expect(latchBeforeSign('near')).toBe(true)
    expect(latchBeforeSign('evm')).toBe(true)
  })

  it('is not set for wallets that return signed bytes', () => {
    expect(latchBeforeSign('solana')).toBe(false)
    expect(latchBeforeSign('sui')).toBe(false)
  })
})

describe('afterSigning', () => {
  it.each(['wallet_error', 'rejected'] as const)(
    'a NEAR %s asks the user to check the wallet and never returns to review',
    (reason) => {
      const step = afterSigning({ ok: false, reason }, 'near')
      expect(step.next).toBe('unknown')
      expect((step as { error: string }).error).toContain(CHECK_WALLET)
      expect((step as { error: string }).error).toContain('new message')
    }
  )

  it('lets a signed-bytes wallet decline back to review', () => {
    expect(afterSigning({ ok: false, reason: 'rejected' }, 'solana')).toEqual({ next: 'review' })
    expect(afterSigning({ ok: false, reason: 'rejected' }, 'sui')).toEqual({ next: 'review' })
  })

  it('fails a signed-bytes wallet error plainly', () => {
    expect(afterSigning({ ok: false, reason: 'wallet_error', detail: 'no' }, 'sui')).toEqual({
      next: 'failed',
      error: 'no',
    })
  })

  it('submits what a wallet signed', () => {
    const signed = { family: 'solana', signedTransaction: 'x' } as const
    expect(afterSigning({ ok: true, signed }, 'solana')).toEqual({ next: 'submit', signed })
  })
})

describe('afterSubmitting', () => {
  it('keeps the latch on success and on an unknown outcome', () => {
    expect(afterSubmitting({ ok: true, hash: 'h', explorerUrl: 'u' }, 'solana')).toMatchObject({
      phase: 'settled',
      latched: true,
    })
    expect(
      afterSubmitting({ ok: false, pending: true, error: 'maybe sent it' }, 'sui')
    ).toMatchObject({ phase: 'pending', latched: true })
    expect(afterSubmitting({ ok: false, error: 'odd' }, 'near')).toMatchObject({
      phase: 'pending',
      latched: true,
    })
    expect(afterSubmitting(undefined, 'solana')).toMatchObject({ phase: 'pending', latched: true })
  })

  it('releases the latch only for a clean refusal on a signed-bytes wallet', () => {
    expect(
      afterSubmitting({ ok: false, error: 'The quote moved too far.' }, 'solana')
    ).toMatchObject({ phase: 'failed', latched: false })
  })
})

describe('the two double-spend paths', () => {
  it('Dismiss then Review after a pending result stays closed', () => {
    // Dismiss resets the card to idle; the latch belongs to the race and survives.
    const done = afterSubmitting({ ok: false, pending: true, error: 'maybe sent it' }, 'sui')
    expect(done.latched).toBe(true)
    const { outcome, prepare } = review('idle', done.latched)
    expect(outcome).toBe('ignored')
    expect(prepare).not.toHaveBeenCalled()
  })

  it('a NEAR wallet_error then Review stays closed, in every phase it can land in', () => {
    const latched = latchBeforeSign('near')
    expect(afterSigning({ ok: false, reason: 'wallet_error' }, 'near').next).toBe('unknown')
    for (const phase of ['pending', 'failed', 'idle'] as const) {
      const { outcome, prepare } = review(phase, latched)
      expect(outcome).toBe('ignored')
      expect(prepare).not.toHaveBeenCalled()
    }
  })

  it('a decline on Solana before anything is sent can still be reviewed again', () => {
    expect(afterSigning({ ok: false, reason: 'rejected' }, 'solana').next).toBe('review')
    expect(review('review', latchBeforeSign('solana')).outcome).toBe('prepared')
  })
})

describe('accountMismatch on the review card', () => {
  it('refuses a wallet other than the one the card was built for', () => {
    expect(accountMismatch('b.near', 'a.near')).toContain('Nothing was sent')
    expect(accountMismatch(undefined, 'a.near')).toBeDefined()
  })

  it('accepts the same account', () => {
    expect(accountMismatch('a.near', 'a.near')).toBeUndefined()
  })
})

describe('unknown outcomes keep the latch and Review closed', () => {
  // The body the chain submit route sends from its catch-all.
  const route502 = {
    ok: false,
    pending: true,
    error:
      "This could not be confirmed. Check your wallet's activity before trying again, in case it went through.",
  }
  const notConfirmed = {
    ok: false,
    pending: true,
    error:
      'This was sent, but not confirmed yet. Check https://solscan.io/tx/x before trying again.',
  }
  const unknownJupiterCode = {
    ok: false,
    pending: true,
    error:
      'Jupiter hasn’t confirmed this swap, and it may still have gone through, so don’t send it again. Check your wallet’s activity first, and get a fresh quote only if nothing changed.',
  }

  it.each([
    ['the route catch-all', route502],
    ['a send not confirmed yet', notConfirmed],
    ['an unknown Jupiter code', unknownJupiterCode],
  ])('%s', (_name, body) => {
    for (const family of ['solana', 'sui'] as const) {
      const done = afterSubmitting(body, family)
      expect(done).toMatchObject({ phase: 'pending', latched: true })
      for (const phase of ['pending', 'idle', 'failed'] as const) {
        const { outcome, prepare } = review(phase, done.latched)
        expect(outcome).toBe('ignored')
        expect(prepare).not.toHaveBeenCalled()
      }
    }
  })
})

describe('panelErrorMessage', () => {
  const said = 'No route could be priced right now. Nothing was signed or sent.'
  it('keeps the sentence while nothing may be signed', () => {
    expect(panelErrorMessage(said, false)).toBe(said)
  })
  it('drops it when it is not the last sentence', () => {
    expect(
      panelErrorMessage('Not priced. Nothing was signed or sent. Try again later.', true)
    ).toBe('Not priced. Try again later.')
  })
  it('drops it once something may have been', () => {
    expect(panelErrorMessage(said, true)).toBe('No route could be priced right now.')
  })
})
