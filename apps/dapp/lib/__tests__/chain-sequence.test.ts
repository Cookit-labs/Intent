import { describe, expect, it } from 'vitest'

import { assertNativeReserve } from '../chains/prepare'
import { chainHelp } from '../chains/explain'
import { chainCapabilities } from '../chains/capabilities'
import {
  chainRouteFromReading,
  parseChainSequence,
  type ReadSwap,
  sequenceFromReading,
  swapFromReading,
} from '../chains/parse-sequence'
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
  it('reads no amount from a decimal comma, and keeps real groups', () => {
    for (const amount of ['1,5', '0,5', '1,50', '10,00', '0,500', '00,500', '01,000']) {
      expect(parseChainSequence(`swap ${amount} SOL to USDC then cash out`)).toBeNull()
    }
    const read = (typed: string): unknown => {
      const parsed = parseChainSequence(`swap ${typed} SOL to USDC then cash out`)
      return parsed !== null && 'swap' in parsed ? parsed.swap.amount : undefined
    }
    expect(read('1,000.5')).toBe('1000.5')
    expect(read('.5')).toBe('0.5')
    expect(read('05')).toBe('5')
  })

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
  it('starts no swap on an amount with a leading zero, which may be a decimal comma', () => {
    for (const typed of ['cash out 0,500 sol', 'cash out 05 sol', 'cash out 0,500 sol to kes']) {
      expect(routeCashout(parseCashout(typed), 'solana')).toEqual({ kind: 'token', token: 'SOL' })
    }
    expect(routeCashout(parseCashout('cash out 0,500 sol'), 'avalanche')).toMatchObject({
      kind: 'token',
    })
  })

  it('still starts one on an ordinary amount', () => {
    expect(routeCashout(parseCashout('cash out 0.5 sol'), 'solana')).toMatchObject({
      kind: 'sequence',
      amount: '0.5',
    })
    expect(routeCashout(parseCashout('cash out 1,500 sol'), 'solana')).toMatchObject({
      kind: 'sequence',
      amount: '1500',
    })
  })

  it('leaves Stellar and what the parser reads exactly as they were', () => {
    expect(parseCashout('cash out 0,500 sol')).toEqual({ unsupportedToken: 'SOL', amount: '0500' })
    expect(routeCashout(parseCashout('cash out 0,500 sol'), 'stellar')).toEqual({ kind: 'pass' })
    expect(routeCashout(parseCashout('cash out 0,500 sol to kes'), 'stellar')).toEqual({
      kind: 'token',
      token: 'SOL',
    })
  })

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
    expect(unsupportedTokenReply('SOL', 'solana')).toMatch(/Swap your SOL to USDC first/)
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

const RECIPIENT = ADDRESS
const reading = (over: Partial<ReadSwap> = {}) => ({
  text: 'swap 5 SOL to USDC then send it',
  tokenIn: 'SOL',
  tokenOut: 'USDC',
  amountUsd: 5,
  amountStated: true,
  followOn: null as ReadSwap['followOn'],
  ...over,
})

describe('sequenceFromReading', () => {
  const said = [`swap 5 SOL to USDC then send to ${RECIPIENT}`]

  it('reads a swap with a cash-out, a deposit and a send, and nothing without a follow-on', () => {
    const swap = { kind: 'swap', amount: '5', tokenIn: 'SOL', tokenOut: 'USDC', venue: undefined }
    expect(
      sequenceFromReading(reading({ followOn: { kind: 'offramp', venue: 'weave' } }), said)
    ).toEqual({ swap, followOn: { kind: 'cashout' } })
    expect(
      sequenceFromReading(reading({ followOn: { kind: 'lend', venue: 'blend' } }), said)
    ).toEqual({ swap, followOn: { kind: 'supply' } })
    expect(
      sequenceFromReading(
        reading({ followOn: { kind: 'send', venue: '', recipient: RECIPIENT } }),
        said
      )
    ).toEqual({ swap, followOn: { kind: 'send', recipient: RECIPIENT } })
    expect(sequenceFromReading(reading(), said)).toBeNull()
  })

  it('refuses a send to a recipient the person never typed, character for character', () => {
    const other = `${ADDRESS.slice(0, -1)}V`
    const out = sequenceFromReading(
      reading({ followOn: { kind: 'send', venue: '', recipient: other } }),
      said
    )
    expect(out).toMatchObject({ refusal: expect.stringContaining('Nothing was signed or sent.') })
    expect(out).toHaveProperty('refusal')
    const lower = sequenceFromReading(
      reading({ followOn: { kind: 'send', venue: '', recipient: RECIPIENT.toLowerCase() } }),
      said
    )
    expect(lower).toHaveProperty('refusal')
    const inside = sequenceFromReading(
      reading({ followOn: { kind: 'send', venue: '', recipient: RECIPIENT.slice(1) } }),
      said
    )
    expect(inside).toHaveProperty('refusal')
  })

  it('refuses an amount the person never typed', () => {
    const out = sequenceFromReading(
      reading({ amountUsd: 500, followOn: { kind: 'offramp', venue: 'weave' } }),
      said
    )
    expect(out).toHaveProperty('refusal')
  })

  it('refuses a token the person never typed', () => {
    const out = sequenceFromReading(
      reading({ tokenIn: 'JUP', followOn: { kind: 'offramp', venue: 'weave' } }),
      said
    )
    expect(out).toHaveProperty('refusal')
  })

  it('refuses a dollar amount, a received amount and a cash-out not ending in USDC', () => {
    const f = { followOn: { kind: 'offramp', venue: 'weave' } }
    expect(sequenceFromReading(reading({ ...f, amountIsUsd: true }), said)).toHaveProperty(
      'refusal'
    )
    expect(sequenceFromReading(reading({ ...f, amountOf: 'received' }), said)).toHaveProperty(
      'refusal'
    )
    expect(sequenceFromReading(reading({ ...f, tokenOut: 'USDT' }), said)).toHaveProperty('refusal')
  })

  it('keeps a venue only when the person named it, and refuses one they did not', () => {
    const named = reading({ followOn: { kind: 'lend', venue: 'kamino', venueNamed: true } })
    expect(sequenceFromReading(named, ['swap 5 SOL to USDC then deposit on Kamino'])).toMatchObject(
      { followOn: { kind: 'supply', venue: 'kamino' } }
    )
    expect(sequenceFromReading(named, said)).toHaveProperty('refusal')
  })
})

describe('swapFromReading', () => {
  it('reads a plain swap from the persons own words only', () => {
    expect(swapFromReading(reading(), ['swap 5 SOL to USDC'])).toEqual({
      kind: 'swap',
      amount: '5',
      tokenIn: 'SOL',
      tokenOut: 'USDC',
      venue: undefined,
    })
    expect(swapFromReading(reading({ amountUsd: 9 }), ['swap 5 SOL to USDC'])).toHaveProperty(
      'refusal'
    )
  })
})

describe('chainHelp in the new forms', () => {
  it('lists swap then cash out, deposit and send per chain', () => {
    const help = (chain: 'solana' | 'near' | 'monad' | 'sui' | 'avalanche', name: string): string =>
      chainHelp(name, chainCapabilities(chain) ?? [])
    expect(help('solana', 'Solana')).toContain('"swap 5 SOL to USDC then cash out"')
    expect(help('solana', 'Solana')).toContain('"swap 5 SOL to USDC then send to an address"')
    expect(help('sui', 'Sui')).toContain('"swap 5 SUI to USDC then cash out"')
    expect(help('avalanche', 'Avalanche')).toContain('"swap 5 AVAX to USDC then cash out"')
    expect(help('near', 'NEAR')).toContain('"swap 5 NEAR to USDC then deposit"')
    expect(help('near', 'NEAR')).not.toContain('then cash out')
    expect(help('near', 'NEAR')).not.toContain('then stake')
    expect(help('monad', 'Monad')).toContain('"swap 5 MON to USDC then send to an address"')
    expect(help('monad', 'Monad')).not.toMatch(/then (cash out|deposit)/)
    expect(help('monad', 'Monad')).toContain('"send 5 USDC to an address"')
  })
})

describe('routeCashout plain form on a chain', () => {
  it('drops a leading-zero amount off Stellar so the person types it', () => {
    expect(routeCashout(parseCashout('cash out 0,500 usdc to kes'), 'solana')).toEqual({
      kind: 'open',
      currency: 'KES',
    })
    expect(routeCashout(parseCashout('cash out 0,500 usdc'), 'solana')).toEqual({ kind: 'ask' })
    expect(routeCashout(parseCashout('cash out 05 usdc'), 'sui')).toEqual({ kind: 'ask' })
    expect(routeCashout(parseCashout('cash out 0.5 usdc'), 'solana')).toEqual({
      kind: 'ask',
      amount: '0.5',
    })
  })

  it('leaves Stellar as it was', () => {
    expect(routeCashout(parseCashout('cash out 0,500 usdc to kes'), 'stellar')).toEqual({
      kind: 'open',
      amount: '0500',
      currency: 'KES',
    })
    expect(routeCashout(parseCashout('cash out 0,500 usdc'), 'stellar')).toEqual({
      kind: 'ask',
      amount: '0500',
    })
  })
})

describe('chainRouteFromReading', () => {
  const read = (over: Partial<ReadSwap & { action: string }> = {}) => ({
    ...reading(),
    action: 'swap',
    ...over,
  })
  const SENT = `swap 5 SOL to USDC then send to ${ADDRESS}`

  it('reads a sequence the model wrote out when it set no follow-on, from the persons words', () => {
    expect(chainRouteFromReading(read(), SENT, [SENT])).toMatchObject({
      sequence: { followOn: { kind: 'send', recipient: ADDRESS } },
    })
  })

  it('refuses a written-out send to an address the person never typed', () => {
    const typed = ['swap 5 SOL to USDC then send it to my friend']
    expect(chainRouteFromReading(read(), SENT, typed)).toHaveProperty('refusal')
    expect(chainRouteFromReading(read(), `send 5 USDC to ${ADDRESS}`, typed)).toHaveProperty(
      'refusal'
    )
  })

  it('refuses a written-out amount the person never typed', () => {
    const typed = ['swap SOL to USDC then send to ' + ADDRESS]
    expect(chainRouteFromReading(read(), SENT, typed)).toHaveProperty('refusal')
  })

  it('runs a plain send and a plain swap that are in the persons words', () => {
    const send = `send 5 USDC to ${ADDRESS}`
    expect(chainRouteFromReading(read(), send, [send])).toMatchObject({
      action: { kind: 'send', recipient: ADDRESS },
    })
    expect(
      chainRouteFromReading(read(), 'Flip 5 SOL into USDC', ['flip 5 sol into usdc'])
    ).toMatchObject({ action: { kind: 'swap', amount: '5', tokenIn: 'SOL', tokenOut: 'USDC' } })
    expect(
      chainRouteFromReading(read({ amountUsd: 9 }), 'Flip 9 SOL into USDC', [
        'flip 5 sol into dollars',
      ])
    ).toHaveProperty('refusal')
  })

  it('reads nothing from a model that is not swapping and wrote no action', () => {
    expect(chainRouteFromReading(read({ action: 'borrow' }), 'borrow some', ['borrow'])).toBeNull()
  })
})

describe('the output token of a model reading', () => {
  const send = { kind: 'send', venue: '', recipient: ADDRESS }

  it('refuses a token out the person never named, where a send follows', () => {
    const out = sequenceFromReading(reading({ tokenOut: 'BONK', followOn: send }), [
      `swap 5 SOL then send to ${ADDRESS}`,
    ])
    expect(out).toHaveProperty('refusal')
    expect(JSON.stringify(out)).not.toContain('BONK')
  })

  it('passes the token out when the person typed it', () => {
    expect(
      sequenceFromReading(reading({ followOn: send }), [
        `swap 5 SOL to USDC then send to ${ADDRESS}`,
      ])
    ).toMatchObject({ swap: { tokenOut: 'USDC' } })
  })

  it('implies USDC for a cash-out with no output named, and only then', () => {
    const cash = { kind: 'offramp', venue: 'weave' }
    expect(sequenceFromReading(reading({ followOn: cash }), ['cash out 5 SOL'])).toMatchObject({
      followOn: { kind: 'cashout' },
    })
    expect(
      sequenceFromReading(reading({ tokenOut: 'BONK', followOn: cash }), ['cash out 5 SOL'])
    ).toHaveProperty('refusal')
  })

  it('refuses a deposit and a plain swap with an output the person did not name', () => {
    expect(
      sequenceFromReading(reading({ followOn: { kind: 'lend', venue: 'x' } }), [
        'swap 5 SOL then deposit',
      ])
    ).toHaveProperty('refusal')
    expect(swapFromReading(reading(), ['swap 5 SOL'])).toHaveProperty('refusal')
  })

  it('reads a chain name as its token out', () => {
    expect(
      swapFromReading(reading({ tokenIn: 'USDC', tokenOut: 'SOL' }), ['swap 5 USDC to solana'])
    ).toMatchObject({ tokenOut: 'SOL' })
    expect(
      swapFromReading(reading({ tokenIn: 'USDC', tokenOut: 'SOL' }), ['swap 5 USDC on solana'])
    ).toHaveProperty('refusal')
  })
})

describe('the order of a swap in the persons words', () => {
  const swap = (tokenIn: string, tokenOut: string, amountUsd = 5) =>
    reading({ tokenIn, tokenOut, amountUsd })

  it('refuses a reversed swap, though each word is there', () => {
    expect(swapFromReading(swap('JitoSOL', 'SOL'), ['swap 5 SOL to JitoSOL'])).toHaveProperty(
      'refusal'
    )
  })

  it('passes the same order, with the amount either side of the token', () => {
    expect(swapFromReading(swap('SOL', 'JitoSOL'), ['swap 5 SOL to JitoSOL'])).toMatchObject({
      tokenIn: 'SOL',
      tokenOut: 'JitoSOL',
    })
    expect(swapFromReading(swap('SOL', 'USDC'), ['swap SOL 5 to USDC'])).toMatchObject({
      tokenIn: 'SOL',
    })
    expect(swapFromReading(swap('SOL', 'USDC'), ['swap 5 of my sol to usdc'])).toMatchObject({
      tokenIn: 'SOL',
    })
  })

  it('refuses an amount that sits beside the other token', () => {
    expect(swapFromReading(swap('SOL', 'USDC'), ['swap SOL to 5 USDC'])).toHaveProperty('refusal')
  })

  it('reads across clarified turns in order', () => {
    expect(swapFromReading(swap('SOL', 'USDC'), ['swap some sol', '5', 'to usdc'])).toMatchObject({
      tokenIn: 'SOL',
      tokenOut: 'USDC',
    })
    expect(swapFromReading(swap('USDC', 'SOL'), ['swap some sol', '5', 'to usdc'])).toHaveProperty(
      'refusal'
    )
  })

  it('applies to a sequence, and a cash-out with no output named only needs the amount by the token', () => {
    const send = { kind: 'send', venue: '', recipient: ADDRESS }
    expect(
      sequenceFromReading(reading({ tokenIn: 'USDC', tokenOut: 'SOL', followOn: send }), [
        `swap 5 SOL to USDC then send to ${ADDRESS}`,
      ])
    ).toHaveProperty('refusal')
    expect(
      sequenceFromReading(reading({ followOn: { kind: 'offramp', venue: 'weave' } }), [
        'cash out 5 SOL',
      ])
    ).toMatchObject({ followOn: { kind: 'cashout' } })
  })
})

describe('a venue the model adds to a plain action', () => {
  const read = { ...reading(), action: 'supply' }
  it('is dropped unless the person said it, keeping the action', () => {
    expect(
      chainRouteFromReading(read, 'supply 25 USDC on Kamino', ['supply 25 USDC'])
    ).toMatchObject({ action: { kind: 'supply', amount: '25', venue: undefined } })
    expect(
      chainRouteFromReading(read, 'supply 25 USDC on Kamino', ['supply 25 USDC on kamino'])
    ).toMatchObject({ action: { venue: 'Kamino' } })
  })
})
