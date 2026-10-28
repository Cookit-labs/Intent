import { beforeEach, describe, expect, it, vi } from 'vitest'

import { setHistoryOwner } from '../history-owner'
import { clearPendingCashOut, pendingCashOut, setPendingCashOut } from '../pending-cashout'

/**
 * A reminder for a swap that settled meaning to be cashed out, left behind by
 * a closed tab. Local-only: see the module's own header for why this is not
 * a `ChatTurn` field.
 */

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  setHistoryOwner(undefined)
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  })
})

describe('pendingCashOut', () => {
  it('is undefined when nothing was set', () => {
    expect(pendingCashOut()).toBeUndefined()
  })

  it('returns what was set', () => {
    setPendingCashOut('HASH1', '82.4')
    expect(pendingCashOut()).toMatchObject({ swapHash: 'HASH1', receiveDisplay: '82.4' })
  })

  it('clears', () => {
    setPendingCashOut('HASH1', '82.4')
    clearPendingCashOut()
    expect(pendingCashOut()).toBeUndefined()
  })

  it('overwrites a previous reminder rather than keeping both', () => {
    setPendingCashOut('HASH1', '82.4')
    setPendingCashOut('HASH2', '10')
    expect(pendingCashOut()).toMatchObject({ swapHash: 'HASH2', receiveDisplay: '10' })
  })

  it('keeps one wallet from reading another’s reminder in the same browser', () => {
    setHistoryOwner('GFIRST')
    setPendingCashOut('HASH1', '82.4')

    setHistoryOwner('GSECOND')
    expect(pendingCashOut()).toBeUndefined()

    setHistoryOwner('GFIRST')
    expect(pendingCashOut()).toMatchObject({ swapHash: 'HASH1' })
  })

  it('ignores a value that does not parse as a reminder', () => {
    store.set('intent.pending-cashout.v1', 'not json')
    expect(pendingCashOut()).toBeUndefined()
  })

  it('does not throw when storage is unavailable', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('blocked')
        },
        setItem: () => {
          throw new Error('blocked')
        },
        removeItem: () => {
          throw new Error('blocked')
        },
      },
    })
    expect(() => setPendingCashOut('HASH1', '82.4')).not.toThrow()
    expect(pendingCashOut()).toBeUndefined()
    expect(() => clearPendingCashOut()).not.toThrow()
  })
})
