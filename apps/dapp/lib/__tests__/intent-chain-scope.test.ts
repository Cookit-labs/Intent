import { describe, expect, it } from 'vitest'

import { getIntentClient } from '../sdk'

/**
 * Intents are per-chain.
 *
 * A Stellar wallet cannot settle an Arc order, so listing both together
 * offered the user trades they had no way to act on. The list was previously
 * unfiltered and intents carried no chain at all.
 */
describe('intent listing is chain-scoped', () => {
  const client = getIntentClient()

  const input = {
    type: 'accumulate' as const,
    tokenIn: 'USDC',
    tokenOut: 'XLM',
    amountIn: '200',
    minAmountOut: '1000',
    deadline: new Date(Date.now() + 60_000).toISOString(),
  }

  it('records the chain an intent was created on', async () => {
    const created = await client.intents.create({ ...input, chain: 'stellar' })
    expect(created.chain).toBe('stellar')
  })

  it('does not show one chain the other chain orders', async () => {
    await client.intents.create({ ...input, chain: 'stellar' })
    await client.intents.create({ ...input, chain: 'arc' })

    const stellar = await client.intents.list('stellar')
    const arc = await client.intents.list('arc')

    expect(stellar.every((i) => i.chain !== 'arc')).toBe(true)
    expect(arc.every((i) => i.chain !== 'stellar')).toBe(true)
  })

  it('keeps intents recorded before chains were tracked', async () => {
    // Hiding a settled trade because it predates a schema change would be
    // worse than showing it on both chains.
    await client.intents.create(input)
    const listed = await client.intents.list('stellar')
    expect(listed.some((i) => i.chain === undefined)).toBe(true)
  })

  it('returns everything when no chain is given', async () => {
    await client.intents.create({ ...input, chain: 'stellar' })
    await client.intents.create({ ...input, chain: 'arc' })
    expect((await client.intents.list()).length).toBeGreaterThanOrEqual(2)
  })
})
