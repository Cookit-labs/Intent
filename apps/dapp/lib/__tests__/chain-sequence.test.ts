import { describe, expect, it } from 'vitest'

import { assertNativeReserve } from '../chains/prepare'
import { parseChainSequence } from '../chains/parse-sequence'
import {
  SEQUENCE_CASHOUT_CHAINS,
  cashoutAmountFrom,
  deliveredAmount,
  followOnRefusal,
  strandedReply,
} from '../chains/sequence'
import { ChainActionRefused, type ChainModule, type WalletBalances } from '../chains/types'
import { unsupportedTokenReply } from '../weave/cashout-view'
import { parseCashout, routeCashout } from '../weave/parse-cashout'

const ADDRESS = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const SOL_MINT = 'So11111111111111111111111111111111111111112'

describe('parseChainSequence', () => {
  it('reads a chain name as its token, in or out', () => {
    expect(parseChainSequence('swap 1 solana to USDC then cash out')).toMatchObject({
      swap: { tokenIn: 'SOL', tokenOut: 'USDC' },
    })
    expect(parseChainSequence('swap 5 USDC to monad then deposit')).toMatchObject({
      swap: { tokenIn: 'USDC', tokenOut: 'MON' },
    })
  })

  it('names the token, not the chain, when refusing a cash-out that does not end in USDC', () => {
    expect(parseChainSequence('swap 5 USDC to solana then cash out')).toEqual({
      refusal:
        'Cash-outs take USDC, so this swap would have to end in USDC, not SOL. Nothing was signed or sent.',
    })
  })

  it.each([
    ['swap 5 SOL to USDC then cash out', { kind: 'cashout' }],
    ['swap 5 SOL to USDC and cash out to kes', { kind: 'cashout', currency: 'KES' }],
    ['swap 5 SOL to USDC, offramp', { kind: 'cashout' }],
    ['swap 5 SOL to USDC and then withdraw to bank', { kind: 'cashout' }],
    ['swap 5 SOL to USDC then deposit', { kind: 'supply' }],
    ['swap 5 SOL to USDC then stake', { kind: 'stake' }],
    [`swap 5 SOL to USDC then send to ${ADDRESS}`, { kind: 'send', recipient: ADDRESS }],
    [`swap 5 SOL to USDC then send it to ${ADDRESS}`, { kind: 'send', recipient: ADDRESS }],
  ])('reads %s', (text, followOn) => {
    expect(parseChainSequence(text)).toEqual({
      swap: { kind: 'swap', amount: '5', tokenIn: 'SOL', tokenOut: 'USDC', venue: undefined },
      followOn,
    })
  })

  it('keeps the recipient in the case it was written', () => {
    const read = parseChainSequence('swap 5 SOL to USDC then transfer to AbCdEf')
    expect(read).toMatchObject({ followOn: { kind: 'send', recipient: 'AbCdEf' } })
  })

  it('refuses a cash-out after a swap that does not end in USDC', () => {
    const read = parseChainSequence('swap 5 SOL to BONK then cash out')
    expect(read).toHaveProperty('refusal')
    expect((read as { refusal: string }).refusal).toMatch(/take USDC/)
    expect((read as { refusal: string }).refusal).toMatch(/Nothing was signed or sent\.$/)
  })

  it('lets any output token go on to supply, stake or send', () => {
    expect(parseChainSequence('swap 5 SOL to BONK then stake')).toMatchObject({
      followOn: { kind: 'stake' },
    })
  })

  it('leaves a plain swap and a plain deposit alone', () => {
    expect(parseChainSequence('swap 5 SOL to USDC')).toBeNull()
    expect(parseChainSequence('deposit 5 SOL')).toBeNull()
  })
})

describe('a token read beside a currency we do not pay', () => {
  it('names the currency instead of dropping it', () => {
    for (const text of ['cash out 5 sol to brl', 'sell 5 sol for euros']) {
      const read = parseCashout(text)
      expect(read).toHaveProperty('unsupportedCurrency')
      expect(routeCashout(read, 'solana')).toMatchObject({ kind: 'currency' })
      expect(routeCashout(read, 'stellar')).toEqual({ kind: 'pass' })
    }
  })
})

describe('parseChainSequence strictness', () => {
  it.each([
    'swap 5 SOL to USDC then send 2 to X',
    'swap 5 SOL to USDC and swap 2 to BONK',
    'swap 5 SOL to USDC then cash out half',
    'swap 5 SOL to USDC then cash out 3',
    `swap 5 SOL to USDC then send to ${ADDRESS}?`,
    `swap 5 SOL to USDC then send to ${ADDRESS},`,
    `swap 5 SOL to USDC then send to ${ADDRESS})`,
  ])('returns null for %s', (text) => {
    expect(parseChainSequence(text)).toBeNull()
  })

  it('reads a NEAR account and drops one trailing stop', () => {
    expect(parseChainSequence('swap 5 SOL to USDC then send to alice.near.')).toMatchObject({
      followOn: { kind: 'send', recipient: 'alice.near' },
    })
    expect(parseChainSequence('swap 5 SOL to USDC then send to a_b-c.near!')).toMatchObject({
      followOn: { kind: 'send', recipient: 'a_b-c.near' },
    })
  })
})

describe('routeCashout with an amount', () => {
  it('becomes a sequence on chains that can finish it', () => {
    expect(routeCashout({ unsupportedToken: 'SOL', amount: '0.5' }, 'solana')).toEqual({
      kind: 'sequence',
      token: 'SOL',
      amount: '0.5',
    })
    expect(
      routeCashout({ unsupportedToken: 'SOL', amount: '0.5', currency: 'KES' }, 'sui')
    ).toEqual({ kind: 'sequence', token: 'SOL', amount: '0.5', currency: 'KES' })
  })

  it('reads USDT as a sequence too', () => {
    expect(routeCashout(parseCashout('cash out 5 USDT to KES'), 'avalanche')).toEqual({
      kind: 'sequence',
      token: 'USDT',
      amount: '5',
      currency: 'KES',
    })
  })

  it('passes on stellar and stays a token case elsewhere', () => {
    expect(routeCashout({ unsupportedToken: 'SOL', amount: '0.5' }, 'stellar')).toEqual({
      kind: 'pass',
    })
    expect(routeCashout({ unsupportedToken: 'SOL' }, 'solana')).toEqual({
      kind: 'token',
      token: 'SOL',
    })
    expect(routeCashout({ unsupportedToken: 'SOL', amount: '0.5' }, 'near')).toEqual({
      kind: 'token',
      token: 'SOL',
    })
    expect(routeCashout({ unsupportedToken: 'SOL', amount: '0.5' }, 'monad')).toEqual({
      kind: 'pass',
    })
  })

  it('keeps the amount read, but not a dollar figure as a token amount', () => {
    expect(parseCashout('cash out 5 sol')).toEqual({ unsupportedToken: 'SOL', amount: '5' })
    expect(parseCashout('cash out $5 sol')).toEqual({ unsupportedToken: 'SOL' })
  })

  it('says on NEAR only what is true there', () => {
    const reply = unsupportedTokenReply('SOL', 'near')
    expect(reply).toMatch(/NEAR/)
    expect(reply).not.toMatch(/then cash out/i)
    expect(unsupportedTokenReply('SOL')).toMatch(/Swap your SOL to USDC first/)
  })
})

describe('deliveredAmount', () => {
  it('measures in base units', () => {
    expect(deliveredAmount('1.5', '6.5', 6)).toBe('5')
    expect(deliveredAmount('0.1', '0.3', 6)).toBe('0.2')
  })

  it('measures at 18 and 24 decimals, and ignores trailing zeros', () => {
    expect(deliveredAmount('1', '1.000000000000000001', 18)).toBe('0.000000000000000001')
    expect(deliveredAmount('0.1', '0.3', 18)).toBe('0.2')
    expect(deliveredAmount('1', '2.5', 24)).toBe('1.5')
    expect(deliveredAmount('1.5', '6.50', 6)).toBe('5')
  })

  it('gives nothing when a side is missing or nothing arrived', () => {
    expect(deliveredAmount(undefined, '6.5', 6)).toBeUndefined()
    expect(deliveredAmount('1', undefined, 6)).toBeUndefined()
    expect(deliveredAmount('2', '2', 6)).toBeUndefined()
    expect(deliveredAmount('3', '2', 6)).toBeUndefined()
  })
})

describe('cashoutAmountFrom', () => {
  it('leaves room for the fee, rounding down to 2 places', () => {
    expect(cashoutAmountFrom('5')).toBe('4.9')
    expect(cashoutAmountFrom('5.05')).toBe('4.95')
    expect(cashoutAmountFrom('0.02')).toBe('0.01')
    expect(cashoutAmountFrom('1.234567')).toBe('1.21')
  })

  it('gives nothing for zero or what is not an amount', () => {
    expect(cashoutAmountFrom('0.01')).toBeUndefined()
    expect(cashoutAmountFrom('abc')).toBeUndefined()
    expect(cashoutAmountFrom('0')).toBeUndefined()
  })
})

describe('followOnRefusal', () => {
  const swapVenue = [{ kinds: ['swap'] as const }]
  const earnVenue = [{ kinds: ['swap', 'supply', 'stake'] as const }]

  it('names why a cash-out cannot run', () => {
    expect(followOnRefusal('near', 'NEAR', { kind: 'cashout' }, swapVenue)).toMatch(
      /Weave.*NEAR deposits.*unavailable/
    )
    expect(followOnRefusal('monad', 'Monad', { kind: 'cashout' }, swapVenue)).toMatch(
      /don't run on Monad/
    )
    expect(followOnRefusal('solana', 'Solana', { kind: 'cashout' }, swapVenue)).toBeUndefined()
  })

  it('names the chain when no venue offers a supply or stake', () => {
    expect(followOnRefusal('sui', 'Sui', { kind: 'supply' }, swapVenue)).toMatch(/Sui/)
    expect(followOnRefusal('sui', 'Sui', { kind: 'stake' }, swapVenue)).toMatch(/stake/)
    expect(followOnRefusal('sui', 'Sui', { kind: 'supply' }, earnVenue)).toBeUndefined()
  })

  it('lets a send through', () => {
    expect(
      followOnRefusal('solana', 'Solana', { kind: 'send', recipient: ADDRESS }, earnVenue)
    ).toBeUndefined()
  })

  it('ends every refusal the same way', () => {
    for (const r of [
      followOnRefusal('near', 'NEAR', { kind: 'cashout' }, []),
      followOnRefusal('monad', 'Monad', { kind: 'cashout' }, []),
      followOnRefusal('sui', 'Sui', { kind: 'supply' }, []),
    ]) {
      expect(r).toMatch(/ Nothing was signed or sent\.$/)
    }
  })

  it('lists the chains that can cash out', () => {
    expect([...SEQUENCE_CASHOUT_CHAINS]).toEqual(['solana', 'sui', 'avalanche'])
  })
})

describe('strandedReply', () => {
  it('says what reached the wallet and that the next step did not run', () => {
    const reply = strandedReply('USDC', '5', { kind: 'supply' })
    expect(reply).toBe(
      'The swap went through and about 5 USDC reached your wallet, but the next step did not run.'
    )
  })

  it('names no number when the amount is unknown', () => {
    const reply = strandedReply('USDC', undefined, { kind: 'stake' })
    expect(reply).not.toMatch(/\d/)
    expect(reply).toBe(
      'The swap went through, but I could not confirm what reached your wallet, so the next step did not run. What arrived stays in your wallet. Check your wallet before doing anything else.'
    )
  })

  it('adds that nothing was paid out only for a cash-out', () => {
    expect(strandedReply('USDC', '5', { kind: 'cashout' })).toMatch(/ Nothing was paid out\.$/)
    expect(strandedReply('USDC', undefined, { kind: 'cashout' })).toMatch(
      / Nothing was paid out\.$/
    )
    expect(strandedReply('USDC', '5', { kind: 'send', recipient: 'x' })).not.toMatch(/paid out/)
  })
})

describe('assertNativeReserve', () => {
  function chainWith(balances: () => Promise<WalletBalances>, calls = { n: 0 }): ChainModule {
    return {
      chain: 'solana',
      tokens: [
        { symbol: 'SOL', id: SOL_MINT, decimals: 9 },
        { symbol: 'USDC', id: 'usdc-mint', decimals: 6 },
      ],
      balances: async () => {
        calls.n += 1
        return balances()
      },
    } as unknown as ChainModule
  }
  const held =
    (amount: string): (() => Promise<WalletBalances>) =>
    async () => ({
      complete: true,
      tokens: [{ symbol: 'SOL', id: SOL_MINT, amount, decimals: 9, native: true, listed: true }],
    })
  const ask = (amount: string, tokenIn = 'SOL') => ({
    kind: 'swap' as const,
    amount,
    tokenIn,
    tokenOut: 'USDC',
  })

  it('refuses spending the whole native balance, naming what can be spent', async () => {
    const run = assertNativeReserve(chainWith(held('0.01477')), ask('0.01477'), 'acct')
    await expect(run).rejects.toBeInstanceOf(ChainActionRefused)
    await expect(run).rejects.toThrow(
      'Keep about 0.005 SOL for network fees. You can spend up to 0.00977 SOL here. Nothing was signed or sent.'
    )
  })

  it('lets an amount that leaves the reserve through', async () => {
    await expect(
      assertNativeReserve(chainWith(held('0.01477')), ask('0.009'), 'acct')
    ).resolves.toBeUndefined()
  })

  it('does not read anything for a token that is not native', async () => {
    const calls = { n: 0 }
    await assertNativeReserve(chainWith(held('0.01'), calls), ask('5', 'USDC'), 'acct')
    expect(calls.n).toBe(0)
  })

  it('passes when the balance cannot be read', async () => {
    const failing = async (): Promise<WalletBalances> => {
      throw new Error('rpc down')
    }
    await expect(
      assertNativeReserve(chainWith(failing), ask('0.01477'), 'acct')
    ).resolves.toBeUndefined()
  })

  it('passes when the read never answers, after a short wait', async () => {
    const hangs = (): Promise<WalletBalances> => new Promise(() => undefined)
    const started = Date.now()
    await expect(
      assertNativeReserve(chainWith(hangs), ask('0.01477'), 'acct')
    ).resolves.toBeUndefined()
    expect(Date.now() - started).toBeLessThan(5000)
  }, 8000)

  it('makes no balance-based refusal for wNEAR', async () => {
    const calls = { n: 0 }
    const near = {
      chain: 'near',
      tokens: [
        { symbol: 'NEAR', id: 'wrap.near', decimals: 24 },
        { symbol: 'wNEAR', id: 'wrap.near', decimals: 24 },
      ],
      balances: async () => {
        calls.n += 1
        return { complete: true, tokens: [] }
      },
    } as unknown as ChainModule
    await expect(
      assertNativeReserve(
        near,
        { kind: 'swap', amount: '99', tokenIn: 'wNEAR', tokenOut: 'USDC' },
        'a'
      )
    ).resolves.toBeUndefined()
    expect(calls.n).toBe(0)
  })

  it('matches NEAR, held natively, to the wrapped token the table names', async () => {
    const near = {
      chain: 'near',
      tokens: [{ symbol: 'NEAR', id: 'wrap.near', decimals: 24 }],
      balances: async () => ({
        complete: true,
        tokens: [
          { symbol: 'NEAR', id: 'near', amount: '1', decimals: 24, native: true, listed: true },
          {
            symbol: 'wNEAR',
            id: 'wrap.near',
            amount: '9',
            decimals: 24,
            native: false,
            listed: true,
          },
        ],
      }),
    } as unknown as ChainModule
    await expect(
      assertNativeReserve(
        near,
        { kind: 'swap', amount: '0.99', tokenIn: 'NEAR', tokenOut: 'USDC' },
        'a'
      )
    ).rejects.toThrow(/Keep about 0.05 NEAR/)
  })
})
