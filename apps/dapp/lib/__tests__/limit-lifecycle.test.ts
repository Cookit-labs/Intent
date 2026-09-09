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

  it('stays open even once the market reaches the limit', async () => {
    const created = await client.intents.create({
      ...base,
      type: 'accumulate',
      deadline: future(),
      limitPriceUsd: 0.19,
    })

    // Reaching the price is not the same as having traded. Nothing signs or
    // submits for a resting order yet, so advancing the status here would
    // claim a transaction that does not exist — which is what filled history
    // with settled rows carrying no hash.
    const seen = await client.intents.get(created.id, { XLM: 0.18 })
    expect(seen.status).toBe('pending')
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

  it('refuses to cancel an intent that has already settled', async () => {
    const created = await client.intents.create({
      chain: 'stellar',
      type: 'market_buy',
      tokenIn: 'USDC',
      tokenOut: 'XLM',
      amountIn: '200',
      minAmountOut: '1000',
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
    })

    // Settled means a transaction hash was recorded, so the chain owns the
    // outcome and this app must not claim otherwise. Nothing leaves 'pending'
    // on a timer any more.
    await client.intents.settle(created.id, 'c'.repeat(64))
    await expect(client.intents.cancel(created.id)).rejects.toThrow(/no longer be cancelled/)
  })
})

/**
 * Nothing reports as completed without a transaction behind it.
 *
 * The old lifecycle marked every intent `settled` fourteen seconds after
 * creation, so history filled with rows that read as finished trades and had
 * no hash — none of them had ever been submitted to a network.
 */
describe('only real transactions count as settled', () => {
  const client = getIntentClient()

  const input = {
    chain: 'stellar' as const,
    type: 'market_buy' as const,
    tokenIn: 'USDC',
    tokenOut: 'XLM',
    amountIn: '200',
    minAmountOut: '1000',
    deadline: new Date(Date.now() + 3_600_000).toISOString(),
  }

  it('does not settle a market intent on elapsed time', async () => {
    const created = await client.intents.create(input)
    // Well past the fourteen seconds the old timer used.
    expect((await client.intents.get(created.id)).status).toBe('pending')
  })

  it('settles only once a hash is recorded', async () => {
    const created = await client.intents.create(input)
    expect((await client.intents.get(created.id)).status).toBe('pending')

    await client.intents.settle(created.id, 'd'.repeat(64))

    const settled = await client.intents.get(created.id)
    expect(settled.status).toBe('settled')
    expect(settled.settlementTxHash).toBe('d'.repeat(64))
  })

  it('cancels an expired limit order rather than settling it', async () => {
    const created = await client.intents.create({
      ...input,
      type: 'limit_buy',
      deadline: new Date(Date.now() - 1_000).toISOString(),
      limitPriceUsd: 0.19,
    })
    expect((await client.intents.get(created.id, { XLM: 0.1 })).status).toBe('cancelled')
  })
})

/**
 * Only a limit order has an open state.
 *
 * A market order is signed within moments or not at all — it has nothing to
 * wait for. One was being written the instant Execute was clicked, before any
 * signature, so an unsigned swap sat in history reading "Swap · Open" forever,
 * describing a trade that never happened.
 */
describe('market orders do not rest', () => {
  const client = getIntentClient()

  const market = {
    chain: 'stellar' as const,
    type: 'market_sell' as const,
    tokenIn: 'XLM',
    tokenOut: 'USDC',
    amountIn: '1640',
    minAmountOut: '300',
  }

  it('reports an unsigned market order past its deadline as failed', async () => {
    const created = await client.intents.create({
      ...market,
      deadline: new Date(Date.now() - 1_000).toISOString(),
    })
    // Not pending: nobody is waiting on it, the signature never came.
    expect((await client.intents.get(created.id)).status).toBe('failed')
  })

  it('still settles a market order that produced a hash', async () => {
    const created = await client.intents.create({
      ...market,
      deadline: new Date(Date.now() + 60_000).toISOString(),
    })
    await client.intents.settle(created.id, 'e'.repeat(64))

    const settled = await client.intents.get(created.id)
    expect(settled.status).toBe('settled')
    expect(settled.settlementTxHash).toBe('e'.repeat(64))
  })

  it('leaves a limit order resting past nothing but its deadline', async () => {
    const created = await client.intents.create({
      ...market,
      type: 'limit_sell',
      limitPriceUsd: 0.3,
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
    })
    // A limit order genuinely waits — that is what it is for.
    expect((await client.intents.get(created.id)).status).toBe('pending')
  })
})
