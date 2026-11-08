import { describe, expect, it } from 'vitest'

import { SOLANA_TOKENS } from '../chains/solana/tokens'
import { describeMovement, displayAmount, solanaMovement } from '../server/chain-lookup'

const ME = 'Me11111111111111111111111111111111111111111'
const POOL = 'Poo1111111111111111111111111111111111111111'
const SOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

function tx(
  sol: { pre: number; post: number },
  tokens: { owner: string; mint: string; pre?: string; post?: string }[],
  fee = 5000
) {
  return {
    meta: {
      err: null,
      fee,
      preBalances: [sol.pre, 0],
      postBalances: [sol.post, 0],
      preTokenBalances: tokens
        .filter((t) => t.pre !== undefined)
        .map((t, i) => ({
          accountIndex: i + 2,
          mint: t.mint,
          owner: t.owner,
          uiTokenAmount: { amount: t.pre! },
        })),
      postTokenBalances: tokens
        .filter((t) => t.post !== undefined)
        .map((t, i) => ({
          accountIndex: i + 2,
          mint: t.mint,
          owner: t.owner,
          uiTokenAmount: { amount: t.post! },
        })),
    },
    transaction: { message: { accountKeys: [{ pubkey: ME }, { pubkey: POOL }] } },
  }
}

describe('what a transaction sold, read from what it moved', () => {
  it('reads SOL for USDC as a swap of the SOL, leaving out the fee', () => {
    const moved = solanaMovement(
      tx({ pre: 2_000_005_000, post: 1_000_000_000 }, [
        { owner: ME, mint: USDC, pre: '0', post: '150000000' },
      ]),
      ME
    )
    expect(describeMovement('solana', SOLANA_TOKENS, moved)).toMatchObject({
      kind: 'swap',
      token: { symbol: 'SOL' },
      amountIn: '1',
      assetOut: 'USDC',
    })
  })

  it('reads USDC sent to someone as a send, and the rent beside it as nothing', () => {
    const moved = solanaMovement(
      tx({ pre: 10_000_000, post: 7_960_000 }, [
        { owner: ME, mint: USDC, pre: '5000000', post: '0' },
        { owner: POOL, mint: USDC, post: '5000000' },
      ]),
      ME
    )
    expect(describeMovement('solana', SOLANA_TOKENS, moved)).toMatchObject({
      kind: 'send',
      token: { symbol: 'USDC' },
      amountIn: '5',
    })
  })

  it('reads nothing from a failed transaction or one that sold no listed token', () => {
    const failed = solanaMovement(tx({ pre: 2, post: 1 }, []), ME)
    expect(describeMovement('solana', SOLANA_TOKENS, { ...failed, ok: false })).toBeUndefined()
    const gasOnly = solanaMovement(tx({ pre: 1_000_005_000, post: 1_000_000_000 }, []), ME)
    expect(describeMovement('solana', SOLANA_TOKENS, gasOnly)).toBeUndefined()
  })

  it('writes base units as decimal text without rounding', () => {
    expect(displayAmount(BigInt('1500000'), 6)).toBe('1.5')
    expect(displayAmount(BigInt('7'), 9)).toBe('0.000000007')
    expect(displayAmount(BigInt('200000000'), 6)).toBe('200')
  })
})
