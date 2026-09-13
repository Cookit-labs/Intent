import { describe, expect, it } from 'vitest'

import { getIntentClient } from '../sdk'

/**
 * Placing an order is not the same as filling one.
 *
 * Both produce a real transaction hash, which is exactly why they are easy to
 * conflate — and conflating them would put an unfilled order in history as a
 * completed trade. That is the fiction the old fourteen-second timer produced,
 * and it would be worse arrived at honestly, because the hash would be real
 * and the claim still false.
 */
describe('an order on the book has not traded', () => {
  const client = getIntentClient()

  const limitOrder = {
    chain: 'stellar' as const,
    type: 'limit_buy' as const,
    tokenIn: 'USDC',
    tokenOut: 'XLM',
    amountIn: '50',
    minAmountOut: '500',
    deadline: new Date(Date.now() + 3_600_000).toISOString(),
    limitPriceUsd: 0.09,
  }

  it('records the offer without claiming a fill', async () => {
    const created = await client.intents.create(limitOrder)
    const placed = await client.intents.place(created.id, '8224', 'a'.repeat(64))

    expect(placed.stellarOfferId).toBe('8224')
    expect(placed.placementTxHash).toBe('a'.repeat(64))
    // Still waiting. The order exists; the trade does not.
    expect(placed.status).toBe('pending')
    expect(placed.settlementTxHash).toBeUndefined()
  })

  it('keeps the placement hash separate from the settlement hash', async () => {
    const created = await client.intents.create(limitOrder)
    await client.intents.place(created.id, '8225', 'b'.repeat(64))
    const settled = await client.intents.settle(created.id, 'c'.repeat(64))

    // Two distinct events, two distinct hashes, both true.
    expect(settled.placementTxHash).toBe('b'.repeat(64))
    expect(settled.settlementTxHash).toBe('c'.repeat(64))
    expect(settled.status).toBe('settled')
  })

  it('still lets a resting order be withdrawn', async () => {
    const created = await client.intents.create(limitOrder)
    await client.intents.place(created.id, '8226', 'd'.repeat(64))

    const cancelled = await client.intents.cancel(created.id)
    expect(cancelled.status).toBe('cancelled')
  })

  it('reports a resting order as pending whatever the market does', async () => {
    // Price is no longer the signal. The ledger is: an order is open until the
    // book says otherwise, and reaching the limit does not by itself fill it.
    const created = await client.intents.create(limitOrder)
    await client.intents.place(created.id, '8227', 'e'.repeat(64))

    expect((await client.intents.get(created.id, { XLM: 0.05 })).status).toBe('pending')
    expect((await client.intents.get(created.id, { XLM: 0.5 })).status).toBe('pending')
  })
})
