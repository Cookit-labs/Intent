import { describe, expect, it, vi } from 'vitest'

import {
  chainRouteFromReading,
  readChainMessage,
  requestSaid,
  sequenceFromReading,
} from '../chains/parse-sequence'
import { resolveFollowOn } from '../chains/prepare'
import { avalancheModule, monadModule } from '../chains/evm/module'
import { nearModule } from '../chains/near/module'
import { solanaModule } from '../chains/solana/module'
import { suiModule } from '../chains/sui/module'
import {
  autoMove,
  moveOnSecond,
  readFollowOnPlan,
  swapLine,
  type SequenceStage,
} from '../chains/sequence-flow'
import type { ChainSequenceRequest } from '../chains/sequence'
import { ChainActionRefused, takesOnly, type ChainModule, type ChainVenue } from '../chains/types'

const SOL_ME = '11111111111111111111111111111111'
const SUI_ME = `0x${'a'.repeat(64)}`
const EVM_ME = `0x${'b'.repeat(40)}`

describe('the sentence that asks for a bundle', () => {
  const CHAINS = [
    ['solana', 'sol'],
    ['sui', 'sui'],
    ['near', 'near'],
    ['avalanche', 'avax'],
    ['monad', 'mon'],
  ] as const

  it.each(CHAINS)('reads "deposit that into a yield vault" on %s, naming no venue', (chain, t) => {
    const read = readChainMessage(
      `swap 50 usdc to ${t} and then deposit that into a yield vault`,
      chain,
      chain
    )
    expect(read).toMatchObject({
      kind: 'sequence',
      request: { swap: { amount: '50', tokenIn: 'usdc' }, followOn: { kind: 'supply' } },
    })
    if (read.kind === 'sequence') {
      expect(read.request.followOn).toEqual({ kind: 'supply' })
    }
  })

  it.each([
    'deposit it',
    'deposit that',
    'deposit this',
    'deposit them',
    'deposit the proceeds',
    'deposit everything',
    'deposit all of it',
    'earn yield',
    'earn yield on it',
    'deposit into a vault',
    'deposit that in a yield vault',
    'deposit it into the lending pool',
    'put it in a yield vault',
    'put that into yield',
    'supply to a lending market',
    'save it',
  ])('reads "%s" after a swap as a deposit anywhere', (words) => {
    const read = readChainMessage(`swap 5 usdc to sol then ${words}`, 'solana', 'Solana')
    expect(read).toMatchObject({ kind: 'sequence' })
    if (read.kind === 'sequence') expect(read.request.followOn).toEqual({ kind: 'supply' })
  })

  it.each([
    ['deposit that on kamino', 'kamino'],
    ['deposit it into marginfi', 'marginfi'],
    ['put it on jupiter lend', 'jupiter lend'],
  ])('keeps a venue that was named: "%s"', (words, venue) => {
    const read = readChainMessage(`swap 5 usdc to sol then ${words}`, 'solana', 'Solana')
    if (read.kind !== 'sequence') throw new Error(read.kind)
    expect(read.request.followOn).toEqual({ kind: 'supply', venue })
  })

  it('keeps "earn" as the venue NEAR knows by that name', () => {
    const read = readChainMessage('swap 5 near to usdc then deposit on earn', 'near', 'NEAR')
    if (read.kind !== 'sequence') throw new Error(read.kind)
    expect(read.request.followOn).toEqual({ kind: 'supply', venue: 'earn' })
  })

  it('keeps stake apart from deposit', () => {
    const read = readChainMessage('swap 5 usdc to sol then stake that', 'solana', 'Solana')
    if (read.kind !== 'sequence') throw new Error(read.kind)
    expect(read.request.followOn).toEqual({ kind: 'stake' })
  })

  it('never reads a token other than the one swapped into as "that"', () => {
    expect(
      readChainMessage('swap 5 usdc to sol then deposit the usdc', 'solana', 'Solana')
    ).toEqual({ kind: 'model' })
  })
})

describe('a model that reads "50 usdc" as fifty dollars', () => {
  const said = ['swap 50 usdc to sol and then deposit that into a yield vault']
  const swap = {
    kind: 'swap',
    amount: '50',
    amountIsUsd: true,
    tokenIn: 'USDC',
    tokenOut: 'SOL',
  } as const

  it('still finds the amount in the words, since a stablecoin is what it counts in', () => {
    expect(requestSaid(swap, said)).toBe(true)
  })

  it('leaves the dollar flag out of what runs, so 50 USDC stays 50 USDC', () => {
    const out = sequenceFromReading(
      {
        tokenIn: 'USDC',
        tokenOut: 'SOL',
        amountUsd: 50,
        amountStated: true,
        amountIsUsd: true,
        followOn: { kind: 'lend', venue: 'jupiter-lend' },
      },
      said
    )
    expect(out).toMatchObject({ swap: { amount: '50', tokenIn: 'USDC', tokenOut: 'SOL' } })
    expect((out as ChainSequenceRequest).swap.amountIsUsd).toBeUndefined()
    expect((out as ChainSequenceRequest).followOn).toEqual({ kind: 'supply' })
  })

  it('does not stretch to a different token: 50 of USDC is not 50 of SOL', () => {
    expect(requestSaid({ ...swap, tokenIn: 'SOL', tokenOut: 'USDC' }, said)).toBe(false)
  })

  it('keeps dollars a person really said, a stablecoin or not', () => {
    const out = sequenceFromReading(
      {
        tokenIn: 'USDC',
        tokenOut: 'SOL',
        amountUsd: 50,
        amountStated: true,
        amountIsUsd: true,
        followOn: { kind: 'lend', venue: '' },
      },
      ['swap $50 of usdc to sol then deposit it']
    )
    expect((out as ChainSequenceRequest).swap.amountIsUsd).toBe(true)
  })

  it('drops the flag on a sentence the model wrote out too', () => {
    const route = chainRouteFromReading(
      {
        action: 'swap',
        tokenIn: 'USDC',
        tokenOut: 'SOL',
        amountUsd: 50,
        amountStated: true,
        amountIsUsd: true,
        followOn: null,
      },
      'swap $50 USDC to SOL',
      ['swap 50 usdc to sol']
    )
    expect(route).toMatchObject({ action: { amount: '50', tokenIn: 'USDC' } })
    expect((route as { action: { amountIsUsd?: true } }).action.amountIsUsd).toBeUndefined()
  })

  it('does not take a different figure', () => {
    expect(requestSaid({ ...swap, amount: '500' }, said)).toBe(false)
  })
})

describe('which venue a follow-on goes to', () => {
  function venue(id: string, kind: 'supply' | 'stake', symbols: string[]): ChainVenue {
    return {
      id,
      name: id.toUpperCase(),
      kinds: [kind],
      assertCanFollow: takesOnly(id.toUpperCase(), symbols),
    } as unknown as ChainVenue
  }
  const fake = (venues: ChainVenue[], wrappedToken?: Record<string, string>): ChainModule =>
    ({
      chain: 'solana',
      venues,
      tokens: [
        { symbol: 'USDC', id: 'usdc', decimals: 6, name: 'USDC' },
        { symbol: 'SOL', id: 'sol', decimals: 9, name: 'SOL' },
        { symbol: 'WSOL', id: 'wsol', decimals: 9, name: 'WSOL' },
      ],
      defaultVenue: { supply: 'first', stake: 'staker' },
      ...(wrappedToken === undefined ? {} : { wrappedToken }),
    }) as unknown as ChainModule

  it('leaves the default alone when it takes the token', async () => {
    const chain = fake([venue('second', 'supply', ['USDC']), venue('first', 'supply', ['USDC'])])
    await expect(
      resolveFollowOn(chain, { kind: 'supply', tokenIn: 'USDC' }, SOL_ME)
    ).resolves.toEqual({ kind: 'supply', venue: 'FIRST' })
  })

  it('goes on to a venue that does take it', async () => {
    const chain = fake([venue('first', 'supply', ['USDC']), venue('second', 'supply', ['SOL'])])
    await expect(
      resolveFollowOn(chain, { kind: 'supply', tokenIn: 'SOL' }, SOL_ME)
    ).resolves.toEqual({ kind: 'supply', venue: 'SECOND' })
  })

  it('stakes what nothing lends, and says so', async () => {
    const chain = fake([venue('first', 'supply', ['USDC']), venue('staker', 'stake', ['SOL'])])
    const plan = await resolveFollowOn(chain, { kind: 'supply', tokenIn: 'SOL' }, SOL_ME)
    expect(plan).toMatchObject({ kind: 'stake', venue: 'STAKER' })
    expect(plan.note).toMatch(/SOL/)
    expect(plan.note).toMatch(/STAKER/)
  })

  it('swaps to the wrapped token where only that can be lent, and says so', async () => {
    const chain = fake([venue('first', 'supply', ['WSOL'])], { SOL: 'WSOL' })
    const plan = await resolveFollowOn(chain, { kind: 'supply', tokenIn: 'SOL' }, SOL_ME)
    expect(plan).toMatchObject({ kind: 'supply', venue: 'FIRST', tokenOut: 'WSOL' })
    expect(plan.note).toMatch(/WSOL/)
  })

  it('says why the wrapped form could not go in, when that was the only way', async () => {
    const full: ChainVenue = {
      id: 'first',
      name: 'FIRST',
      kinds: ['supply'],
      assertCanFollow: async ({ tokenIn }: { tokenIn: string }) => {
        if (tokenIn === 'WSOL') throw new ChainActionRefused('FIRST is full of WSOL.')
        throw new ChainActionRefused('FIRST takes WSOL here, not SOL.')
      },
    } as unknown as ChainVenue
    await expect(
      resolveFollowOn(fake([full], { SOL: 'WSOL' }), { kind: 'supply', tokenIn: 'SOL' }, SOL_ME)
    ).rejects.toThrow('FIRST is full of WSOL.')
  })

  it('prefers a stake over a wrap, since that keeps the token asked for', async () => {
    const chain = fake([venue('first', 'supply', ['WSOL']), venue('staker', 'stake', ['SOL'])], {
      SOL: 'WSOL',
    })
    const plan = await resolveFollowOn(chain, { kind: 'supply', tokenIn: 'SOL' }, SOL_ME)
    expect(plan.kind).toBe('stake')
  })

  it('refuses in the default venue words when nothing can take it', async () => {
    const chain = fake([venue('first', 'supply', ['USDC'])])
    await expect(
      resolveFollowOn(chain, { kind: 'supply', tokenIn: 'SOL' }, SOL_ME)
    ).rejects.toThrow('FIRST takes USDC here, not SOL')
  })

  it('never swaps out a venue the person named', async () => {
    const chain = fake([venue('first', 'supply', ['USDC']), venue('second', 'supply', ['SOL'])])
    await expect(
      resolveFollowOn(chain, { kind: 'supply', tokenIn: 'SOL', venue: 'first' }, SOL_ME)
    ).rejects.toThrow('FIRST takes USDC here, not SOL')
  })

  it('does not turn a stake into anything else', async () => {
    const chain = fake([venue('first', 'supply', ['SOL']), venue('staker', 'stake', ['USDC'])])
    await expect(resolveFollowOn(chain, { kind: 'stake', tokenIn: 'SOL' }, SOL_ME)).rejects.toThrow(
      'STAKER takes USDC here, not SOL'
    )
  })

  it('refuses a token this chain does not list before asking any venue', async () => {
    const chain = fake([venue('first', 'supply', ['DOGE'])])
    await expect(
      resolveFollowOn(chain, { kind: 'supply', tokenIn: 'DOGE' }, SOL_ME)
    ).rejects.toThrow(/verified/)
  })
})

describe('your sentence, on each chain as it stands', () => {
  // A fixed balance: the fee check reads the wallet, and a live read made these pass or fail by chance.
  const holding = (
    chain: ChainModule,
    symbol: string,
    amount: string,
    decimals: number
  ): ChainModule =>
    ({
      ...chain,
      balances: async () => ({ tokens: [{ symbol, amount, decimals, native: true }] }),
    }) as unknown as ChainModule

  it('Solana lends SOL on Kamino', async () => {
    await expect(
      resolveFollowOn(
        holding(solanaModule, 'SOL', '1', 9),
        { kind: 'supply', tokenIn: 'SOL' },
        SOL_ME
      )
    ).resolves.toEqual({ kind: 'supply', venue: 'Kamino Lend' })
  })

  it('Sui stakes SUI, since nothing here lends it', async () => {
    await expect(
      resolveFollowOn(holding(suiModule, 'SUI', '1', 9), { kind: 'supply', tokenIn: 'SUI' }, SUI_ME)
    ).resolves.toMatchObject({ kind: 'stake', venue: 'SpringSui' })
  })

  it('Avalanche knows WAVAX is how AVAX is lent, whether or not Aave has room today', () => {
    expect(avalancheModule.wrappedToken).toEqual({ AVAX: 'WAVAX' })
  })

  it('Avalanche swaps into WAVAX where it is listed, since 1Click does not list it', () => {
    expect(avalancheModule.venueForToken?.swap?.['WAVAX']).toBe('uniswap-avalanche')
    expect(avalancheModule.venues.some((v) => v.id === 'uniswap-avalanche')).toBe(true)
  })

  it('Monad stakes MON on FastLane', async () => {
    await expect(
      resolveFollowOn(
        holding(monadModule, 'MON', '1', 18),
        { kind: 'supply', tokenIn: 'MON' },
        EVM_ME
      )
    ).resolves.toMatchObject({ kind: 'stake', venue: 'FastLane' })
  })

  it('Monad refuses before the swap when too little MON is left for both fees', async () => {
    await expect(
      resolveFollowOn(
        holding(monadModule, 'MON', '0', 18),
        { kind: 'supply', tokenIn: 'MON' },
        EVM_ME
      )
    ).rejects.toThrow(/Keep at least/)
  })

  it('NEAR stakes NEAR, since a stake can follow a swap there', async () => {
    await expect(
      resolveFollowOn(
        holding(nearModule, 'NEAR', '1', 24),
        { kind: 'supply', tokenIn: 'NEAR' },
        'someone.near'
      )
    ).resolves.toMatchObject({ kind: 'stake' })
  })

  it.each([
    ['Solana', solanaModule, SOL_ME],
    ['Sui', suiModule, SUI_ME],
    ['NEAR', nearModule, 'someone.near'],
  ] as const)('%s takes a USDC deposit', async (_name, chain, account) => {
    await expect(
      resolveFollowOn(chain, { kind: 'supply', tokenIn: 'USDC' }, account)
    ).resolves.toMatchObject({ kind: 'supply' })
  })
})

describe('what the server said, applied to the sequence', () => {
  const REQUEST: ChainSequenceRequest = {
    swap: { kind: 'swap', amount: '50', tokenIn: 'USDC', tokenOut: 'AVAX', venue: undefined },
    followOn: { kind: 'supply' },
  }
  const answer = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

  it('takes the venue, the kind, the token and the note', async () => {
    vi.stubGlobal(
      'fetch',
      answer(200, {
        ok: true,
        kind: 'supply',
        venue: 'Aave',
        tokenOut: 'WAVAX',
        note: 'Aave takes WAVAX.',
      })
    )
    const plan = await readFollowOnPlan('avalanche', REQUEST, EVM_ME)
    expect(plan).toEqual({
      request: {
        swap: { ...REQUEST.swap, tokenOut: 'WAVAX' },
        followOn: { kind: 'supply', venue: 'Aave' },
      },
      note: 'Aave takes WAVAX.',
    })
    vi.unstubAllGlobals()
  })

  it('turns a deposit into a stake only on the server saying so', async () => {
    vi.stubGlobal('fetch', answer(200, { ok: true, kind: 'stake', venue: 'Jito', note: 'n' }))
    const plan = await readFollowOnPlan('solana', REQUEST, SOL_ME)
    expect(plan).toMatchObject({ request: { followOn: { kind: 'stake', venue: 'Jito' } } })
    vi.unstubAllGlobals()
  })

  it('keeps a send as it was typed', async () => {
    const send: ChainSequenceRequest = {
      ...REQUEST,
      followOn: { kind: 'send', recipient: 'alice' },
    }
    vi.stubGlobal('fetch', answer(200, { ok: true, kind: 'send' }))
    await expect(readFollowOnPlan('solana', send, SOL_ME)).resolves.toEqual({ request: send })
    vi.unstubAllGlobals()
  })

  it('passes a refusal on', async () => {
    vi.stubGlobal('fetch', answer(422, { error: 'NAVI takes USDC here, not SUI.' }))
    await expect(readFollowOnPlan('sui', REQUEST, SUI_ME)).resolves.toEqual({
      refusal: 'NAVI takes USDC here, not SUI.',
    })
    vi.unstubAllGlobals()
  })

  it('leaves a cash-out alone, unasked', async () => {
    const cashout: ChainSequenceRequest = { ...REQUEST, followOn: { kind: 'cashout' } }
    const spy = answer(200, { ok: true })
    vi.stubGlobal('fetch', spy)
    await expect(readFollowOnPlan('solana', cashout, SOL_ME)).resolves.toEqual({ request: cashout })
    expect(spy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('step 2 coming up on its own', () => {
  const base = {
    stage: 'ready' as SequenceStage,
    followOnKind: 'supply' as const,
    phase: 'settled' as const,
    opened: false,
    cardKind: 'swap' as const,
    extraArrived: false,
    warned: false,
    prepareTried: false,
    signTried: false,
  }

  it('builds step 2 once the swap has settled and been measured', () => {
    expect(autoMove(base)).toBe('prepare')
  })

  it.each(['swap', 'measuring', 'stranded', 'done', 'unsettled', 'followed', 'next'] as const)(
    'does nothing from %s',
    (stage) => {
      expect(autoMove({ ...base, stage })).toBeUndefined()
    }
  )

  it('builds only once in a run, so a step 2 that failed cleanly waits for a press', () => {
    expect(autoMove({ ...base, prepareTried: true })).toBeUndefined()
  })

  it('leaves a cash-out to its button, since its form wants a bank', () => {
    expect(autoMove({ ...base, followOnKind: 'cashout' })).toBeUndefined()
  })

  it('waits for a press when more arrived than this swap should bring', () => {
    expect(autoMove({ ...base, extraArrived: true })).toBeUndefined()
  })

  const review = {
    ...base,
    stage: 'following' as SequenceStage,
    phase: 'review' as const,
    opened: true,
    cardKind: 'supply' as const,
    prepareTried: true,
  }

  it('opens the wallet on step 2 own card', () => {
    expect(autoMove(review)).toBe('sign')
  })

  it('stops for a press when the card warns this may already have been sent', () => {
    expect(autoMove({ ...review, warned: true })).toBeUndefined()
  })

  it('opens it once for a card, so a decline never reopens it', () => {
    expect(autoMove({ ...review, signTried: true })).toBeUndefined()
  })

  it('never signs a card still showing step 1', () => {
    expect(autoMove({ ...review, opened: false })).toBeUndefined()
  })

  it('never signs a card of any other kind', () => {
    expect(autoMove({ ...review, cardKind: 'swap' })).toBeUndefined()
    expect(autoMove({ ...review, cardKind: 'send' })).toBeUndefined()
  })

  it.each(['idle', 'building', 'signing', 'submitting', 'settled', 'pending', 'failed'] as const)(
    'does not sign from %s',
    (phase) => {
      expect(autoMove({ ...review, phase })).toBeUndefined()
    }
  )

  it('runs a stake and a send the same way', () => {
    expect(autoMove({ ...review, followOnKind: 'stake', cardKind: 'stake' })).toBe('sign')
    expect(autoMove({ ...review, followOnKind: 'send', cardKind: 'send' })).toBe('sign')
  })

  it('goes back to the button when the wallet refused and nothing moved', () => {
    const request: ChainSequenceRequest = {
      swap: { kind: 'swap', amount: '1', tokenIn: 'USDC', tokenOut: 'SOL', venue: undefined },
      followOn: { kind: 'supply' },
    }
    const moved = moveOnSecond(
      { stage: 'following', settled: true, opened: true },
      'failed',
      false,
      request,
      '1',
      'supply'
    )
    expect(moved.stage).toBe('ready')
    expect(autoMove({ ...base, stage: moved.stage, prepareTried: true })).toBeUndefined()
  })
})

describe('what the swap card promises', () => {
  const REQUEST: ChainSequenceRequest = {
    swap: { kind: 'swap', amount: '1', tokenIn: 'USDC', tokenOut: 'SOL', venue: undefined },
    followOn: { kind: 'supply' },
  }

  it('says the wallet comes back by itself, and that it can be declined', () => {
    const line = swapLine('review', 'known', undefined, REQUEST)
    expect(line).toMatch(/wallet/i)
    expect(line).toMatch(/decline/i)
    expect(line).not.toMatch(/press/i)
  })

  it('still says a cash-out waits for a press', () => {
    const line = swapLine('review', 'known', undefined, {
      ...REQUEST,
      followOn: { kind: 'cashout' },
    })
    expect(line).toMatch(/press/i)
  })
})
