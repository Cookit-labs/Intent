import { describe, expect, it } from 'vitest'

import type { RestingOrder } from '../chains/limit'
import { ordersReply } from '../chains/orders-view'
import { tokenListReply, tokenReply, TOKENS_UNREAD } from '../tokens/reply'
import type { TokenRow } from '../tokens/types'

/**
 * A card answers a question in the chat. Once the next message is sent the card goes, so the turn
 * keeps these words in its place, and the saved chat keeps them after a reload.
 */

const order = (over: Partial<RestingOrder> = {}): RestingOrder => ({
  id: '1',
  venueId: 'phoenix',
  tokenIn: 'XLM',
  tokenOut: 'USDC',
  amountIn: '100',
  remainingIn: '100',
  receivedOut: '0',
  limitPrice: '0.5',
  status: 'open',
  ...over,
})

const row = (over: Partial<TokenRow> = {}): TokenRow => ({
  id: 'wal',
  symbol: 'WAL',
  priceUsd: 0.42,
  liquidityUsd: 1_200_000,
  marketCapUsd: 300_000_000,
  holders: 52_000,
  verified: ['CoinGecko'],
  listed: true,
  explorerUrl: 'https://example.com/wal',
  ...over,
})

describe('ordersReply', () => {
  it('says there are none', () => {
    expect(ordersReply([])).toBe('You have no resting limit orders here.')
  })

  it('lists each order on its own line, with its venue', () => {
    const reply = ordersReply([order(), order({ id: '2', amountIn: '40', remainingIn: '40' })])
    expect(reply.split('\n')).toEqual([
      'Your limit orders:',
      'Sell 100 XLM at $0.5, via phoenix',
      'Sell 40 XLM at $0.5, via phoenix',
    ])
  })

  it('says when they could not be read, never that there are none', () => {
    expect(ordersReply(undefined)).toBe(
      'Your orders could not be read just now. Nothing was signed or sent.'
    )
  })
})

describe('token replies', () => {
  it('lists the tokens the card showed, with price and liquidity', () => {
    const reply = tokenListReply(
      [row(), row({ id: 'sui', symbol: 'SUI', priceUsd: 3.1, liquidityUsd: 9_000_000 })],
      'Sui'
    )
    expect(reply.split('\n')).toEqual([
      'Tokens on Sui:',
      'WAL $0.42, $1.2M liquidity',
      'SUI $3.10, $9M liquidity',
    ])
  })

  it('lists at most six, like the card', () => {
    const many = Array.from({ length: 9 }, (_, i) => row({ id: `t${i}`, symbol: `T${i}` }))
    expect(tokenListReply(many, 'Sui').split('\n')).toHaveLength(7)
  })

  it("gives one token's figures", () => {
    expect(tokenReply(row(), 'wal', 'Sui')).toBe(
      'WAL on Sui: $0.42, $300M market cap, $1.2M liquidity, 52K holders.'
    )
  })

  it('says when nothing matches', () => {
    expect(tokenReply(undefined, 'zzz', 'Sui')).toBe('Nothing on Sui matches “zzz”.')
  })

  it('says when tokens could not be read', () => {
    expect(TOKENS_UNREAD('Sui')).toBe(
      'Tokens on Sui couldn’t be read just now. Try again in a moment.'
    )
  })
})
