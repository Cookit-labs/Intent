import { describe, expect, it } from 'vitest'

import { getIntentClient } from '../sdk'

/**
 * A limit order must wait for its price.
 *
 * Every intent used to reach `settled` fourteen seconds after creation
 * whatever its type, so "accumulate $200 of XLM below $0.19" filled at
 * $0.1972 almost immediately — through the very limit it named — and there was
 * no window in which it could be cancelled.
 */
describe('limit intents wait for their price', () => {
  const client = getIntentClient()

  const base = {
    chain: 'stellar' as const,
    tokenIn: 'USDC',
    tokenOut: 'XLM',
    amountIn: '200',
    minAmountOut: '1000',
  }

  const future = (): string => new Date(Date.now() + 3_600_000).toISOString()

  it('stays pending while the market is above a buy limit', async () => {
    const created = await client.intents.create({
      ...base,
      type: 'accumulate',
      deadline: future(),
      limitPriceUsd: 0.19,
    })

    // Market at $0.1972 — above the cap, so the order must not fill.
    const seen = await client.intents.get(created.id, { XLM: 0.1972 })
    expect(seen.status).toBe('pending')
  })

  it('progresses once the market reaches the limit', async () => {
    const created = await client.intents.create({
      ...base,
      type: 'accumulate',
      deadline: future(),
      limitPriceUsd: 0.19,
    })

    const seen = await client.intents.get(created.id, { XLM: 0.18 })
    expect(seen.status).not.toBe('pending')
  })

  it('does not claim a fill when no price is known', async () => {
    const created = await client.intents.create({
      ...base,
      type: 'accumulate',
      deadline: future(),
      limitPriceUsd: 0.19,
    })

    expect((await client.intents.get(created.id)).status).toBe('pending')
  })

  it('cancels rather than settles an expired limit order', async () => {
    const created = await client.intents.create({
      ...base,
      type: 'limit_buy',
      deadline: new Date(Date.now() - 1_000).toISOString(),
      limitPriceUsd: 0.19,
    })

    // Expired unfilled is cancelled. Calling it settled would claim a trade
    // that never happened.
    expect((await client.intents.get(created.id, { XLM: 0.5 })).status).toBe('cancelled')
  })

  it('reads a sell limit in the opposite direction', async () => {
    const created = await client.intents.create({
      ...base,
      type: 'limit_sell',
      tokenIn: 'XLM',
      tokenOut: 'USDC',
      deadline: future(),
      limitPriceUsd: 0.25,
    })

    // Selling wants a price at or above the limit.
    expect((await client.intents.get(created.id, { USDC: 0.2 })).status).toBe('pending')
  })

  it('leaves market intents settling on their existing timeline', async () => {
    const created = await client.intents.create({
      ...base,
      type: 'market_buy',
      deadline: future(),
    })
    expect(created.limitPriceUsd).toBeUndefined()
  })
})

describe('open intents can be withdrawn', () => {
  const client = getIntentClient()

  it('cancels an order that has not started executing', async () => {
    const created = await client.intents.create({
      chain: 'stellar',
      type: 'accumulate',
      tokenIn: 'USDC',
      tokenOut: 'XLM',
      amountIn: '200',
      minAmountOut: '1000',
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
      limitPriceUsd: 0.19,
    })

    const cancelled = await client.intents.cancel(created.id)
    expect(cancelled.status).toBe('cancelled')
  })

  it('refuses to cancel an intent already past pending', async () => {
    const created = await client.intents.create({
      chain: 'stellar',
      type: 'market_buy',
      tokenIn: 'USDC',
      tokenOut: 'XLM',
      amountIn: '200',
      minAmountOut: '1000',
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
    })

    // Market intents leave 'pending' on a timer; once executing, the chain
    // owns the outcome and this app must not claim otherwise.
    await new Promise((r) => setTimeout(r, 3_200))
    await expect(client.intents.cancel(created.id)).rejects.toThrow(/no longer be cancelled/)
  })
})
