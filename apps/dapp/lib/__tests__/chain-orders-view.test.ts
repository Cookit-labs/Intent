import { describe, expect, it } from 'vitest'

import { LIMIT_NOT_HERE } from '../chains/prepare'
import { readChainMessage } from '../chains/parse-sequence'
import { chainHelp } from '../chains/explain'
import {
  exitsFor,
  freshExit,
  GONE,
  limitSettledNote,
  orderLine,
  ordersAsked,
} from '../chains/orders-view'
import type { RestingOrder } from '../chains/limit'
import {
  continueSource,
  earlierAttempt,
  recordAttempt,
  type AttemptStorage,
} from '../chains/signing-flow'

function memory(): AttemptStorage {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  }
}

const order = (over: Partial<RestingOrder> = {}): RestingOrder => ({
  id: 'o1',
  venueId: 'limo',
  tokenIn: 'SOL',
  tokenOut: 'USDC',
  amountIn: '1',
  remainingIn: '1',
  receivedOut: '0',
  limitPrice: '110',
  status: 'open',
  ...over,
})

describe('reading a message off Stellar', () => {
  it('reads a limit order as one', () => {
    const read = readChainMessage('sell 1 SOL at $110', 'solana', 'Solana')
    expect(read).toMatchObject({ kind: 'limit', action: { kind: 'limit', limitPrice: '110' } })
  })

  it('leaves a sequence and a plain swap as they were', () => {
    expect(readChainMessage('swap 1 SOL to USDC then cash out', 'solana', 'Solana').kind).toBe(
      'sequence'
    )
    expect(readChainMessage('swap 1 SOL to USDC', 'solana', 'Solana').kind).toBe('action')
  })

  it('reads a limit before a swap that would take its price for a venue', () => {
    const read = readChainMessage('swap 50 USDC to SOL at 90', 'solana', 'Solana')
    expect(read.kind).toBe('limit')
  })

  it('refuses a limit on Monad with the reason', () => {
    const read = readChainMessage('sell 1 MON at $5', 'monad', 'Monad')
    expect(read).toEqual({ kind: 'refusal', refusal: LIMIT_NOT_HERE.monad })
  })

  it('asks for the spend when a purchase names only what it gets', () => {
    const read = readChainMessage('buy 2 SOL at 90', 'solana', 'Solana')
    expect(read.kind).toBe('refusal')
    expect((read as { refusal: string }).refusal).toContain(
      'Say how much you will spend, for example "buy SOL with 180 USDC at $90".'
    )
  })

  it('asks for a count when the amount is dollars', () => {
    const read = readChainMessage('sell $5 of SOL at $110', 'solana', 'Solana')
    expect((read as { refusal: string }).refusal).toContain(
      'Say how much SOL, for example "sell 0.05 SOL at $110".'
    )
  })

  it('reads a question about orders', () => {
    expect(readChainMessage('my orders', 'solana', 'Solana').kind).toBe('orders')
  })
})

describe('ordersAsked', () => {
  it.each(['my orders', 'show my open orders', 'cancel my order', 'limit orders'])(
    'is true for %s',
    (text) => expect(ordersAsked(text)).toBe(true)
  )
  it.each(['order 5 SOL', 'in order to swap'])('is false for %s', (text) =>
    expect(ordersAsked(text)).toBe(false)
  )
})

describe('exitsFor', () => {
  it('offers cancel on an open order', () => {
    expect(exitsFor(order())).toEqual(['cancel'])
  })
  it('offers cancel and collect on a part-filled one with something to collect', () => {
    const partly = order({
      status: 'partly',
      collectable: [{ amount: '44', symbol: 'USDC' }],
    })
    expect(exitsFor(partly)).toEqual(['cancel', 'collect'])
    expect(exitsFor(order({ status: 'partly' }))).toEqual(['cancel'])
  })
  it('offers collect only on a filled order, and nothing on a done one', () => {
    expect(exitsFor(order({ status: 'filled' }))).toEqual(['collect'])
    expect(exitsFor(order({ status: 'done' }))).toEqual([])
  })
})

describe('freshExit', () => {
  it('turns a cancel into a collect when the order has since filled', () => {
    expect(freshExit(order(), order({ status: 'filled' }), 'cancel')).toBe('collect')
  })
  it('says gone when the order is no longer listed', () => {
    expect(freshExit(order(), undefined, 'cancel')).toBe('gone')
    expect(GONE).toBe('That order is no longer open. Nothing was signed or sent.')
  })
  it('keeps a press that still holds', () => {
    expect(freshExit(order(), order(), 'cancel')).toBe('cancel')
  })
  it('does not call a filled order gone when its money is on the row', () => {
    const waiting = order({
      amountIn: '0',
      status: 'filled',
      collectable: [{ amount: '12', symbol: 'USDC' }],
    })
    expect(freshExit(waiting, waiting, 'collect')).toBe('collect')
    expect(freshExit(order(), waiting, 'cancel')).toBe('collect')
  })
  it('is gone when a collect has nothing left to take', () => {
    expect(freshExit(order({ status: 'filled' }), order({ status: 'done' }), 'collect')).toBe(
      'gone'
    )
  })
})

describe('orderLine', () => {
  it('reads like a sentence', () => {
    const line = orderLine(
      order({ remainingIn: '0.6', expiresAt: Date.UTC(2026, 10, 12, 12), status: 'partly' })
    )
    expect(line).toBe('Sell 1 SOL at $110, 0.4 filled, expires Nov 12')
  })
  it('reads a purchase', () => {
    expect(
      orderLine(
        order({
          tokenIn: 'USDC',
          tokenOut: 'SOL',
          amountIn: '180',
          remainingIn: '180',
          limitPrice: '90',
        })
      )
    ).toBe('Buy SOL with 180 USDC at $90')
  })
  it('leads with what can be collected', () => {
    const line = orderLine(
      order({
        status: 'filled',
        remainingIn: '0',
        collectable: [{ amount: '110', symbol: 'USDC' }],
      })
    )
    expect(line.startsWith('110 USDC ready to collect')).toBe(true)
  })
  it('leads with the money of a waiting row that has no amount', () => {
    const line = orderLine(
      order({
        amountIn: '0',
        remainingIn: '0',
        status: 'filled',
        collectable: [{ amount: '12', symbol: 'USDC' }],
      })
    )
    expect(line).toBe('12 USDC ready to collect')
  })
})

describe('what is said after a limit order settles', () => {
  it('names how to see it, and the second signature on Sui and NEAR', () => {
    expect(limitSettledNote('solana')).toContain('my orders')
    expect(limitSettledNote('solana')).not.toContain('another signature')
    expect(limitSettledNote('sui')).toContain('another signature')
    expect(limitSettledNote('near')).toContain('another signature')
  })
})

describe('a setup step', () => {
  const source = {
    kind: 'request' as const,
    request: { kind: 'limit' as const, amount: '1', tokenIn: 'SOL' },
    asked: 'x',
  }
  it('keeps the request and offers a press once settled, however many rounds', () => {
    expect(continueSource('settled', { thenPrepareAgain: true }, source)).toBe(source)
    expect(continueSource('settled', { thenPrepareAgain: true }, source)).toBe(source)
  })
  it('does nothing while building, or without a setup step', () => {
    expect(continueSource('building', { thenPrepareAgain: true }, source)).toBeUndefined()
    expect(continueSource('settled', {}, source)).toBeUndefined()
    expect(continueSource('settled', undefined, source)).toBeUndefined()
  })
})

describe('earlier attempts of an exit', () => {
  it('keys an exit by its order and action', () => {
    const storage = memory()
    const base = { chain: 'solana', account: 'a'.repeat(44), tokenIn: 'SOL', amount: '0' }
    recordAttempt(storage, { ...base, at: Date.now(), exit: 'cancel:o1' })
    expect(earlierAttempt(storage, { ...base, exit: 'cancel:o2' })).toBeUndefined()
    expect(earlierAttempt(storage, { ...base, exit: 'collect:o1' })).toBeUndefined()
    expect(earlierAttempt(storage, base)).toBeUndefined()
    expect(earlierAttempt(storage, { ...base, exit: 'cancel:o1' })).toBeDefined()
  })
})

describe('chainHelp', () => {
  it('names limit orders where a venue exists', () => {
    const help = chainHelp('Solana', [{ kind: 'limit', venue: 'Limo', symbol: 'SOL' }])
    expect(help).toContain('sell 1 SOL at $110')
    expect(help).toContain('my orders')
  })
})
