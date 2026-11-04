import { afterEach, describe, expect, it, vi } from 'vitest'

import { evmExplorerUrl } from '../chains/evm/tokens'
import { explorerUrl as nearExplorerUrl } from '../chains/near/tokens'
import {
  accountMismatch,
  afterSigning,
  afterSubmitting,
  ATTEMPT_WINDOW_MS,
  attemptNotice,
  earlierAttempt,
  latchBeforeSign,
  noteSubmitAnswer,
  noteWalletAnswer,
  recordAttempt,
  submitSigned,
  type AfterSigning,
  type AttemptStorage,
} from '../chains/signing-flow'
import { explorerUrl as solanaExplorerUrl } from '../chains/solana/submit'
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

describe('an answer that can not be read, once a signature has gone to the server', () => {
  afterEach(() => vi.unstubAllGlobals())

  const request = { account: 'a', venueId: 'v' }

  it.each([
    ['the platform killing the function', () => new Response('<html>504</html>', { status: 504 })],
    ['an empty answer', () => new Response('', { status: 200 })],
    [
      'the connection dropping',
      () => {
        throw new TypeError('fetch failed')
      },
    ],
  ])('holds the latch after %s', async (_name, answer) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer())
    )
    const result = await submitSigned('/api/chain/solana/submit', request)
    for (const family of ['solana', 'sui'] as const) {
      expect(afterSubmitting(result, family)).toMatchObject({ phase: 'pending', latched: true })
    }
  })

  it('posts the body as JSON and hands back a readable answer as it is', async () => {
    const answer = { ok: false, error: 'The quote moved too far.' }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(answer), { status: 422 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(submitSigned('/api/chain/solana/submit', request)).resolves.toEqual(answer)
    expect(fetchMock).toHaveBeenCalledWith('/api/chain/solana/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
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

describe('the warning that survives a reload', () => {
  const NOW = 1_800_000_000_000
  const MINUTE = 60_000
  const asking = { chain: 'monad', account: '0xabc', tokenIn: 'USDC', amount: '5' }
  const attempt = { ...asking, at: NOW }

  function fakeStorage(start: string | null = null): AttemptStorage & { value: string | null } {
    const store = {
      value: start,
      getItem: () => store.value,
      setItem: (_key: string, value: string) => {
        store.value = value
      },
    }
    return store
  }

  const later = (minutes: number) => NOW + minutes * MINUTE
  const started = () => {
    const storage = fakeStorage()
    recordAttempt(storage, attempt)
    return storage
  }

  describe('matching', () => {
    it('finds an attempt on the same chain, account, token and amount', () => {
      expect(earlierAttempt(started(), asking, later(3))).toEqual(attempt)
    })

    it.each([
      ['chain', { chain: 'avalanche' }],
      ['account', { account: '0xdef' }],
      ['token', { tokenIn: 'USDT0' }],
      ['amount', { amount: '6' }],
    ])('finds nothing for another %s', (_name, change) => {
      expect(earlierAttempt(started(), { ...asking, ...change }, later(3))).toBeUndefined()
    })

    it('reads an EVM address, a token and an amount however they were written', () => {
      const same = { ...asking, account: '0xABC', tokenIn: 'usdc', amount: '5.0' }
      expect(earlierAttempt(started(), same, later(3))).toEqual(attempt)
    })

    it('keeps case in an address where case is part of it', () => {
      const storage = fakeStorage()
      recordAttempt(storage, { ...attempt, chain: 'solana', account: 'SoLaNa' })
      const other = { ...asking, chain: 'solana', account: 'solana' }
      expect(earlierAttempt(storage, other, later(3))).toBeUndefined()
    })

    it('gives the newest of two', () => {
      const storage = started()
      recordAttempt(storage, { ...attempt, at: later(2) })
      expect(earlierAttempt(storage, asking, later(3))?.at).toBe(later(2))
    })
  })

  describe('expiry', () => {
    it('holds for 15 minutes and no longer', () => {
      expect(earlierAttempt(started(), asking, NOW + ATTEMPT_WINDOW_MS)).toEqual(attempt)
      expect(earlierAttempt(started(), asking, NOW + ATTEMPT_WINDOW_MS + 1)).toBeUndefined()
    })

    it('drops expired attempts the next time one is written', () => {
      const storage = started()
      recordAttempt(storage, { ...attempt, tokenIn: 'MON', at: later(20) })
      expect(JSON.parse(storage.value as string)).toHaveLength(1)
    })
  })

  describe('broken storage changes nothing', () => {
    const throwing: AttemptStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('full')
      },
    }

    it.each([
      ['that throws', throwing],
      ['that is missing', undefined],
    ])('storage %s', (_name, storage) => {
      expect(() => recordAttempt(storage, attempt)).not.toThrow()
      expect(() => noteWalletAnswer(storage, attempt, undefined)).not.toThrow()
      expect(() =>
        noteSubmitAnswer(storage, attempt, { ok: true, hash: 'h', explorerUrl: 'u' })
      ).not.toThrow()
      expect(earlierAttempt(storage, asking, later(3))).toBeUndefined()
    })

    it.each([
      ['text that is not JSON', 'not json'],
      ['JSON that is not a list', '{"chain":"monad"}'],
      ['a list of the wrong things', '[1,null,{"chain":"monad","at":"soon"}]'],
    ])('reads %s as nothing, and writes over it', (_name, saved) => {
      const storage = fakeStorage(saved)
      expect(earlierAttempt(storage, asking, later(3))).toBeUndefined()
      recordAttempt(storage, attempt)
      expect(earlierAttempt(storage, asking, later(3))).toEqual(attempt)
    })
  })

  describe('what the wallet answers', () => {
    it.each([
      ['a decline on a wallet that only signs', { next: 'review' }],
      ['an error before anything was sent', { next: 'failed', error: 'no' }],
      ['a wallet that cannot sign here', undefined],
    ] as [string, AfterSigning | undefined][])('forgets the attempt after %s', (_name, step) => {
      const storage = started()
      noteWalletAnswer(storage, attempt, step)
      expect(earlierAttempt(storage, asking, later(1))).toBeUndefined()
    })

    it('keeps the attempt when a wallet that sends for itself gives no confirmation', () => {
      const storage = started()
      noteWalletAnswer(storage, attempt, afterSigning({ ok: false, reason: 'rejected' }, 'evm'))
      expect(earlierAttempt(storage, asking, later(1))).toEqual(attempt)
    })

    it('adds the hash a wallet returned', () => {
      const storage = started()
      noteWalletAnswer(storage, attempt, {
        next: 'submit',
        signed: { family: 'evm', hash: '0xh' },
      })
      expect(earlierAttempt(storage, asking, later(1))?.hash).toBe('0xh')
    })

    it('adds the last of the hashes a NEAR wallet returned, the one its venue follows', () => {
      const storage = started()
      noteWalletAnswer(storage, attempt, {
        next: 'submit',
        signed: { family: 'near', hashes: ['first', 'last'] },
      })
      expect(earlierAttempt(storage, asking, later(1))?.hash).toBe('last')
    })

    it('has no hash yet for signed bytes', () => {
      const storage = started()
      noteWalletAnswer(storage, attempt, {
        next: 'submit',
        signed: { family: 'solana', signedTransaction: 'x' },
      })
      expect(earlierAttempt(storage, asking, later(1))).toEqual(attempt)
    })
  })

  describe('what the server answers', () => {
    it.each([
      ['a clean refusal', { ok: false, error: 'The quote moved too far.' }],
      ['a proven revert', { ok: false, error: 'This transfer failed on Monad.' }],
    ])('forgets the attempt after %s', (_name, body) => {
      const storage = started()
      noteSubmitAnswer(storage, attempt, body)
      expect(earlierAttempt(storage, asking, later(1))).toBeUndefined()
    })

    it.each([
      ['pending', { ok: false, pending: true, error: 'Still going.' }],
      ['no answer at all', undefined],
      ['a code from before the venue was reached', { error: 'invalid_body' }],
    ])('keeps the attempt after %s', (_name, body) => {
      const storage = started()
      noteSubmitAnswer(storage, attempt, body)
      expect(earlierAttempt(storage, asking, later(1))).toEqual(attempt)
    })

    it('keeps the attempt after success, with the hash, since retyping would pay twice', () => {
      const storage = started()
      noteSubmitAnswer(storage, attempt, { ok: true, hash: 'h1', explorerUrl: 'u' })
      expect(earlierAttempt(storage, asking, later(1))?.hash).toBe('h1')
    })

    it('forgets only its own attempt', () => {
      const storage = started()
      const second = { ...attempt, at: later(1) }
      recordAttempt(storage, second)
      noteSubmitAnswer(storage, second, { ok: false, error: 'The quote moved too far.' })
      expect(earlierAttempt(storage, asking, later(2))).toEqual(attempt)
    })
  })

  describe('what the card says', () => {
    it.each([
      [0, 'You started this 1 minute ago, check your wallet first.'],
      [1, 'You started this 1 minute ago, check your wallet first.'],
      [14, 'You started this 14 minutes ago, check your wallet first.'],
    ])('after %i minutes', (minutes, text) => {
      expect(attemptNotice(attempt, later(minutes))).toEqual({ text })
    })

    it.each([
      ['near', nearExplorerUrl('h1')],
      ['monad', evmExplorerUrl('monad', 'h1')],
      ['avalanche', evmExplorerUrl('avalanche', 'h1')],
      ['solana', solanaExplorerUrl('h1')],
      ['sui', 'https://suiscan.xyz/mainnet/tx/h1'],
    ])('links the hash on %s', (chain, explorerUrl) => {
      const notice = attemptNotice({ ...attempt, chain, hash: 'h1' }, later(3))
      expect(notice).toMatchObject({ hash: 'h1', explorerUrl })
    })

    it('keeps a stored hash inside the path of the explorer', () => {
      const notice = attemptNotice({ ...attempt, hash: '../../evil?x=1' }, later(3))
      expect(notice.explorerUrl).toBe(evmExplorerUrl('monad', '..%2F..%2Fevil%3Fx%3D1'))
    })
  })
})
