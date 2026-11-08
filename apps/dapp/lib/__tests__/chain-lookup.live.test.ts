import { describe, expect, it } from 'vitest'

import { EVM_CHAINS } from '../chains/evm/tokens'
import { nearTokens } from '../chains/near/tokens'
import { SOLANA_TOKENS } from '../chains/solana/tokens'
import { SUI_TOKENS } from '../chains/sui/tokens'
import type { ChainToken, ChainWithActions } from '../chains/types'
import { describeMovement, readMovement } from '../server/chain-lookup'

/**
 * The backfill's readers against real mainnet transactions, read back by hash from each chain.
 * Picked on 2026-11-08; a confirmed transaction never changes, so neither do these answers.
 * Avalanche's default public node rate-limits some networks: set AVALANCHE_RPC_URL if it does.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'

const CASES: {
  chain: ChainWithActions
  tokens: readonly ChainToken[]
  hash: string
  account: string
  expected: { kind: string; symbol: string; amountIn: string }
}[] = [
  {
    // USDC for a token this app doesn't list: valued, but not called a swap.
    chain: 'solana',
    tokens: SOLANA_TOKENS,
    hash: '5uuTLDvXZWutZswrom6v4ngtN8SakXm8179FvgBPmC8rbsihjN719do73sNz3kc2i16KDSWQ5iZUU6fSuYRL5uEy',
    account: '9AApQFN4cQXLd7srYnTegRA7eX989Ym1tvzYQMsHsMeB',
    expected: { kind: 'unknown', symbol: 'USDC', amountIn: '200' },
  },
  {
    chain: 'avalanche',
    tokens: EVM_CHAINS.avalanche.tokens,
    hash: '0x7a2c8049ff8fe5d2358980068b2d66af47aff6cab8935aa8b6b4abeddacf56c4',
    account: '0x95894a9da8596206545787300f2e77c5b68e5ac6',
    expected: { kind: 'send', symbol: 'USDC', amountIn: '6.524657' },
  },
  {
    chain: 'monad',
    tokens: EVM_CHAINS.monad.tokens,
    hash: '0xd326127399e275263e2461d7ee381099db4e89895862272e850948483b95de33',
    account: '0xb8bb34ea3daadfe4934fd5c78567b2d5e5c74be9',
    expected: { kind: 'send', symbol: 'USDC', amountIn: '0.998903' },
  },
  {
    chain: 'near',
    tokens: nearTokens,
    hash: 'GAQ5JRJHUG6LaZPHzGFEJnvpxu5U6v7MDM8FMdnaw6Fs',
    account: '7dad72ef20fc837c82be4e6fdbbda47de0ee838a35f1e8c3ba5bddf36b98f009',
    expected: { kind: 'send', symbol: 'USDC', amountIn: '73.759731' },
  },
  {
    chain: 'sui',
    tokens: SUI_TOKENS,
    hash: 'A2BxgZir4YydVasJSEcgKbzS3f8rpfo6z1eEQGCfQB1y',
    account: '0xada1e0409256416b2a60bd6e5e5cd2b5f7c28ca19d0aa5b17657d138a246398f',
    expected: { kind: 'unknown', symbol: 'USDC', amountIn: '21.593028' },
  },
]

describe.skipIf(SKIP)('reading past transactions back from their chain', () => {
  for (const c of CASES) {
    it(`reads what a ${c.chain} transaction sold`, async () => {
      const movement = await readMovement(c.chain, c.hash, c.account)
      expect(movement).toBeDefined()
      const found = describeMovement(c.chain, c.tokens, movement!)
      expect({
        kind: found?.kind,
        symbol: found?.token.symbol,
        amountIn: found?.amountIn,
      }).toEqual(c.expected)
    }, 60_000)
  }

  it('finds nothing for a hash its chain has never seen', async () => {
    expect(await readMovement('solana', '1'.repeat(88), CASES[0]!.account)).toBeUndefined()
  }, 60_000)
})
