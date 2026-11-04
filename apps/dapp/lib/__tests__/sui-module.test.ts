import { describe, expect, it } from 'vitest'

import { naviApy, poolNotes } from '../chains/sui/navi-rules'
import { mintedAmount, SSUI_TYPE } from '../chains/sui/policies'
import { priceFromLlama } from '../chains/sui/price'
import { refusalFromBuildError } from '../chains/sui/client'
import { submitSui, type SuiExecutor } from '../chains/sui/submit'
import { SUI_TOKENS } from '../chains/sui/tokens'
import { suiCapabilities } from '../chains/sui/capabilities'
import { suiVenues } from '../chains/sui/venues'
import { suiModule } from '../chains/sui/module'
import { tokenBySymbol, ChainActionRefused } from '../chains/types'
import { venues } from '../venues'

const NOW = 1_793_720_000_000
const token = (symbol: string) => {
  const found = tokenBySymbol(SUI_TOKENS, symbol)
  if (found === undefined) throw new Error(`no ${symbol}`)
  return found
}

function llama(entry: unknown): typeof fetch {
  return (async (url: string | URL | Request) => {
    const key = decodeURIComponent(String(url)).split('/current/')[1]?.split('?')[0] as string
    return new Response(JSON.stringify({ coins: entry === undefined ? {} : { [key]: entry } }))
  }) as typeof fetch
}

describe('the token list', () => {
  it('holds the exact coin types confirmed on chain', () => {
    expect(SUI_TOKENS.map((t) => [t.symbol, t.id, t.decimals])).toEqual([
      ['SUI', '0x2::sui::SUI', 9],
      ['USDC', '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC', 6],
      [
        'USDsui',
        '0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI',
        6,
      ],
      ['USDT', '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT', 6],
    ])
  })

  it('finds nothing for a lookalike symbol', () => {
    expect(tokenBySymbol(SUI_TOKENS, 'FDUSD')).toBeUndefined()
    expect(tokenBySymbol(SUI_TOKENS, 'wUSDC')).toBeUndefined()
  })
})

describe('priceUsd', () => {
  const fresh = { price: 0.9997, timestamp: NOW / 1000 - 60, confidence: 0.99 }

  it('treats a stablecoin the source agrees with as $1', async () => {
    expect(await priceFromLlama(token('USDC'), llama(fresh), NOW)).toBe(1)
  })

  it('uses the live price for a stablecoin off its peg', async () => {
    const off = { ...fresh, price: 0.97 }
    expect(await priceFromLlama(token('USDT'), llama(off), NOW)).toBe(0.97)
  })

  it('uses the live price for SUI', async () => {
    const sui = { ...fresh, price: 0.8954 }
    expect(await priceFromLlama(token('SUI'), llama(sui), NOW)).toBe(0.8954)
  })

  it('returns nothing for a stale SUI price', async () => {
    const stale = { ...fresh, timestamp: NOW / 1000 - 3600 }
    expect(await priceFromLlama(token('SUI'), llama(stale), NOW)).toBeUndefined()
  })

  it('returns nothing for a low-confidence price', async () => {
    const shaky = { ...fresh, confidence: 0.5 }
    expect(await priceFromLlama(token('SUI'), llama(shaky), NOW)).toBeUndefined()
  })

  it('returns nothing when the token is missing or the price is not positive', async () => {
    expect(await priceFromLlama(token('SUI'), llama(undefined), NOW)).toBeUndefined()
    expect(await priceFromLlama(token('SUI'), llama({ ...fresh, price: 0 }), NOW)).toBeUndefined()
  })

  it('returns nothing, and does not throw, when the request fails', async () => {
    const down = (async () => {
      throw new Error('down')
    }) as typeof fetch
    const bad = (async () => new Response('nope', { status: 500 })) as typeof fetch
    expect(await priceFromLlama(token('SUI'), down, NOW)).toBeUndefined()
    expect(await priceFromLlama(token('SUI'), bad, NOW)).toBeUndefined()
  })

  it('never prices a token outside the list', async () => {
    const other = { symbol: 'USDT', id: '0x778e::usdt::USDT', decimals: 6 }
    expect(await priceFromLlama(other, llama(fresh), NOW)).toBeUndefined()
  })
})

describe('NAVI rate and notes', () => {
  it('keeps base and reward separate, from NAVI’s own fields', () => {
    expect(naviApy({ supplyIncentiveApyInfo: { vaultApr: '8.156', boostedApr: '0.334' } })).toEqual(
      {
        basePercent: 8.156,
        rewardPercent: 0.334,
      }
    )
  })

  it('leaves out a reward of zero', () => {
    expect(naviApy({ supplyIncentiveApyInfo: { vaultApr: '5', boostedApr: '0' } })).toEqual({
      basePercent: 5,
    })
  })

  it('shows no rate rather than a made-up one', () => {
    expect(naviApy({ supplyIncentiveApyInfo: { vaultApr: 'x', boostedApr: '1' } })).toBeUndefined()
    expect(naviApy({})).toBeUndefined()
  })

  it('warns about moving rates and how much can be withdrawn, and promises nothing', () => {
    const notes = poolNotes({ availableUsdc: 2_237_104.66 })
    expect(notes.length).toBeGreaterThanOrEqual(1)
    expect(notes.length).toBeLessThanOrEqual(3)
    expect(notes.join(' ')).toMatch(/\$2\.2M/)
    expect(notes.join(' ')).toMatch(/not guaranteed/i)
    expect(notes.join(' ')).not.toMatch(/guaranteed return|risk.free|safe yield/i)
  })
})

describe('what a stake mints', () => {
  const ME = '0xc6fa48a7455bff49124318d5297320441cfac33f83ceea890c485372de917df4'
  const SUI_CHANGE = { coinType: '0x2::sui::SUI', address: ME, amount: '-1000000000' }

  it('reads the sSUI the dry run paid this account', () => {
    expect(
      mintedAmount([SUI_CHANGE, { coinType: SSUI_TYPE, address: ME, amount: '963360812' }], ME)
    ).toBe('963360812')
  })

  it('finds nothing when it was paid to someone else, or nothing was paid', () => {
    const other = '0x000000000000000000000000000000000000000000000000000000000000dead'
    expect(mintedAmount([{ coinType: SSUI_TYPE, address: other, amount: '5' }], ME)).toBeUndefined()
    expect(mintedAmount([{ coinType: SSUI_TYPE, address: ME, amount: '-5' }], ME)).toBeUndefined()
    expect(mintedAmount([SUI_CHANGE], ME)).toBeUndefined()
    expect(mintedAmount(undefined, ME)).toBeUndefined()
  })
})

describe('reading a failed build', () => {
  it('reads a dry run that ran out of coin as a short balance', () => {
    const e = refusalFromBuildError(
      new Error('Transaction resolution failed: InsufficientCoinBalance in command 0'),
      'SUI'
    )
    expect(e?.message).toMatch(/enough SUI/)
  })

  it('reads the SDK gas selection failure as needing SUI for the fee', () => {
    const e = refusalFromBuildError(
      new Error(
        'Unable to perform gas selection due to insufficient SUI balance (in address balance or coins) for account 0x1234 to satisfy required budget 1188000.'
      ),
      'USDC'
    )
    expect(e?.message).toMatch(/network fee/)
  })

  it('says when the account is short of the token', () => {
    const e = refusalFromBuildError(
      new Error(
        'Insufficient balance of 0x..::usdc::USDC for owner 0x1. Required: 1, Available: 0'
      ),
      'USDC'
    )
    expect(e).toBeInstanceOf(ChainActionRefused)
    expect(e?.message).toMatch(/enough USDC/)
  })

  it('says when there is no SUI for the network fee', () => {
    const e = refusalFromBuildError(
      new Error('No valid gas coins found for the transaction.'),
      'USDC'
    )
    expect(e?.message).toMatch(/SUI/)
  })

  it('says when the dry run fails', () => {
    const e = refusalFromBuildError(
      new Error('Transaction resolution failed: MoveAbort in 2nd command, abort code: 1'),
      'USDC'
    )
    expect(e?.message).toMatch(/would fail/)
  })

  it('leaves an outage for the route to report as an outage', () => {
    expect(refusalFromBuildError(new Error('fetch failed'), 'USDC')).toBeUndefined()
  })
})

describe('submitting signed bytes', () => {
  const signed = { family: 'sui' as const, transaction: 'AAAA', signature: 'BBBB' }
  const input = { account: '0x1', venueId: 'cetus', signed }

  function executor(run: () => unknown): SuiExecutor & { calls: unknown[] } {
    const calls: unknown[] = []
    return {
      calls,
      executeTransaction: async (options: unknown) => {
        calls.push(options)
        return run() as never
      },
    }
  }

  it('sends the bytes and signature, then reports the digest and explorer link', async () => {
    const client = executor(() => ({
      $kind: 'Transaction',
      Transaction: { digest: 'DIGEST', effects: { status: { success: true, error: null } } },
    }))
    expect(await submitSui(input, client)).toEqual({
      ok: true,
      hash: 'DIGEST',
      explorerUrl: 'https://suiscan.xyz/mainnet/tx/DIGEST',
    })
    expect(client.calls[0]).toMatchObject({
      signatures: ['BBBB'],
      include: { effects: true },
    })
  })

  it('reports a transaction that landed and failed, in plain words', async () => {
    const client = executor(() => ({
      $kind: 'FailedTransaction',
      FailedTransaction: {
        digest: 'DIGEST',
        effects: { status: { success: false, error: { message: 'MoveAbort(1)' } } },
      },
    }))
    const result = await submitSui(input, client)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/failed/)
      expect(result.error).toMatch(/network fee/)
      expect(result.error).not.toMatch(/MoveAbort/)
    }
  })

  it('does not call an execution with no effects a success', async () => {
    const client = executor(() => ({ $kind: 'Transaction', Transaction: { digest: 'D' } }))
    await expect(submitSui(input, client)).rejects.toThrow()
  })

  it('refuses anything but Sui bytes', async () => {
    const client = executor(() => {
      throw new Error('should not send')
    })
    const result = await submitSui({ ...input, signed: { family: 'near', hashes: ['x'] } }, client)
    expect(result.ok).toBe(false)
    expect(client.calls).toHaveLength(0)
  })

  it('tells someone to rebuild when their coins changed', async () => {
    const client = executor(() => {
      throw new Error('Object 0xabc not available for consumption, current version: 5')
    })
    const result = await submitSui(input, client)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.error).toMatch(/again/)
  })

  it('says nothing moved when the network rejects it outright', async () => {
    const client = executor(() => {
      throw Object.assign(new Error('Invalid user signature'), { code: 'INVALID_ARGUMENT' })
    })
    const result = await submitSui(input, client)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.error).toMatch(/Nothing moved/)
  })

  it('never claims to know the outcome after a timeout, so the route can say to check', async () => {
    const client = executor(() => {
      throw Object.assign(new Error('deadline exceeded'), { code: 'DEADLINE_EXCEEDED' })
    })
    await expect(submitSui(input, client)).rejects.toThrow(/deadline/)
  })
})

describe('the module', () => {
  it('wires only swap, supply and stake, to Cetus, 1Click, NAVI and SpringSui', () => {
    expect(suiModule.venues.map((v) => [v.id, v.kinds])).toEqual([
      ['cetus', ['swap']],
      ['1click-sui', ['swap']],
      ['navi', ['supply']],
      ['springsui', ['stake']],
    ])
    expect(suiModule.defaultVenue).toEqual({ swap: 'cetus', supply: 'navi', stake: 'springsui' })
  })

  it('offers one capability per wired kind', () => {
    expect(suiCapabilities).toEqual([
      { kind: 'swap', venue: 'Cetus', symbol: 'SUI' },
      { kind: 'supply', venue: 'NAVI', symbol: 'USDC' },
      { kind: 'stake', venue: 'SpringSui', symbol: 'SUI' },
    ])
  })
})

describe('the venue list', () => {
  it('has every row of the report', () => {
    expect(suiVenues).toHaveLength(15)
    expect(new Set(suiVenues.map((v) => v.id)).size).toBe(15)
  })

  it('is all Sui, with a real link and an honest reason', () => {
    for (const venue of suiVenues) {
      expect(venue.family).toBe('sui')
      expect(venue.chains).toEqual(['Sui'])
      expect(venue.url).toMatch(/^https:\/\//)
      expect(venue.bestFor.length).toBeGreaterThan(0)
    }
  })

  it('claims execution only for what is wired, each with a capability', () => {
    const wired = suiModule.venues.map((v) => v.id).sort()
    const claimed = suiVenues.filter((v) => v.integration === 'executes')
    expect(claimed.map((v) => v.id).sort()).toEqual(wired)
    for (const venue of claimed) expect(venue.capability).toBeTruthy()
  })

  it('leaves Linq listed', () => {
    const linq = suiVenues.find((v) => v.name.startsWith('Linq'))
    expect(linq?.integration).toBeUndefined()
    expect(linq?.category).toBe('offramp')
  })

  it('does not collide with an id on another chain', () => {
    const ids = venues.map((v) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
