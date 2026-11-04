import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  balanceReplyDecision,
  balanceReplyIsCurrent,
  chainBalanceReply,
  WALLET_CHANGED_NOTICE,
} from '../chains/balance-reply'
import { readEvmBalances } from '../chains/evm/balances'
import type { EvmClient } from '../chains/evm/client'
import { AVALANCHE_TOKENS, MONAD_TOKENS } from '../chains/evm/tokens'
import { readNearBalances } from '../chains/near/balances'
import { readSolanaBalances } from '../chains/solana/balances'
import { readSuiBalances } from '../chains/sui/balances'
import { ChainActionRefused, type TokenBalance, type WalletBalances } from '../chains/types'

const SOL_OWNER = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const ODD_MINT = 'AbCdEfGhJkLmNpQrStUvWxYzAbCdEfGhJkLmNpQrStUv'
const SUI_OWNER = `0x${'ab'.repeat(32)}`
const SUI_USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
const WAL = '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL'
const EVM_OWNER = `0x${'12'.repeat(20)}`

type Handler = (url: string, body: unknown) => unknown
let calls: { url: string; body: unknown }[] = []

function stubFetch(handler: Handler): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
      if (init?.signal?.aborted === true) throw new Error('aborted')
      calls.push({ url: String(url), body })
      const out = handler(String(url), body)
      if (out instanceof Response) return out
      return new Response(JSON.stringify(out), { status: 200 })
    })
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function tokenAccount(mint: string, amount: string, decimals: number) {
  return {
    pubkey: 'x',
    account: {
      data: { parsed: { info: { mint, tokenAmount: { amount, decimals } } }, program: 'spl-token' },
    },
  }
}

describe('Solana balances', () => {
  const method = (body: unknown): string => (body as { method: string }).method
  const params = (body: unknown): unknown[] => (body as { params: unknown[] }).params

  it('reads SOL and both token programs at confirmed, summing a mint held twice', async () => {
    vi.stubEnv('SOLANA_RPC_URL', '')
    stubFetch((_url, body) => {
      if (method(body) === 'getBalance') return { result: { value: 14_770_000 } }
      const program = (params(body)[1] as { programId: string }).programId
      return {
        result: {
          value:
            program === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
              ? [tokenAccount(USDC_MINT, '1500000', 6), tokenAccount(USDC_MINT, '500000', 6)]
              : [tokenAccount(ODD_MINT, '7', 0)],
        },
      }
    })
    const result = await readSolanaBalances(SOL_OWNER)
    expect(result.complete).toBe(true)
    expect(result.tokens).toContainEqual(
      expect.objectContaining({ symbol: 'SOL', amount: '0.01477', native: true, listed: true })
    )
    expect(result.tokens).toContainEqual(
      expect.objectContaining({ symbol: 'USDC', amount: '2', decimals: 6, listed: true })
    )
    expect(result.tokens).toContainEqual(
      expect.objectContaining({ id: ODD_MINT, amount: '7', listed: false, native: false })
    )
    expect(calls.every((c) => c.url === 'https://api.mainnet-beta.solana.com')).toBe(true)
    for (const c of calls) {
      const last = params(c.body).at(-1) as { commitment: string }
      expect(last.commitment).toBe('confirmed')
    }
    expect(calls).toHaveLength(3)
  })

  it('uses SOLANA_RPC_URL when set', async () => {
    vi.stubEnv('SOLANA_RPC_URL', 'https://rpc.example.test')
    stubFetch((_url, body) => ({
      result: { value: method(body) === 'getBalance' ? 1 : [] },
    }))
    await readSolanaBalances(SOL_OWNER)
    expect(calls.every((c) => c.url === 'https://rpc.example.test')).toBe(true)
  })

  const listingRefused = (byMint: Record<string, unknown[]>) => (_url: string, body: unknown) => {
    if (method(body) === 'getBalance') return { result: { value: 5_000_000_000 } }
    const filter = params(body)[1] as { programId?: string; mint?: string }
    if (filter.programId !== undefined) return new Response('forbidden', { status: 403 })
    return { result: { value: byMint[filter.mint ?? ''] ?? [] } }
  }

  it('falls back to each table token by mint, finding a non-associated account', async () => {
    stubFetch(listingRefused({ [USDC_MINT]: [tokenAccount(USDC_MINT, '250000', 6)] }))
    const result = await readSolanaBalances(SOL_OWNER)
    expect(result.complete).toBe(false)
    expect(result.tokens.find((t) => t.native)?.amount).toBe('5')
    expect(result.tokens.find((t) => t.symbol === 'USDC')?.amount).toBe('0.25')
    expect(result.tokens.find((t) => t.symbol === 'USDT')?.amount).toBe('0')
    expect(result.unread ?? []).toEqual([])
  })

  it('leaves out a table token it cannot read instead of reporting zero', async () => {
    stubFetch((_url, body) => {
      if (method(body) === 'getBalance') return { result: { value: 5_000_000_000 } }
      const filter = params(body)[1] as { mint?: string }
      if (filter.mint === USDC_MINT) return new Response('forbidden', { status: 403 })
      if (filter.mint === undefined) return new Response('forbidden', { status: 403 })
      return { result: { value: [] } }
    })
    const result = await readSolanaBalances(SOL_OWNER)
    expect(result.complete).toBe(false)
    expect(result.unread).toEqual(['USDC'])
    expect(result.tokens.find((t) => t.symbol === 'USDC')).toBeUndefined()
    expect(result.tokens.find((t) => t.symbol === 'USDT')?.amount).toBe('0')
  })

  it('discards the half list when one token program refuses', async () => {
    stubFetch((_url, body) => {
      if (method(body) === 'getBalance') return { result: { value: 5_000_000_000 } }
      const filter = params(body)[1] as { programId?: string; mint?: string }
      if (filter.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
        return { result: { value: [tokenAccount(ODD_MINT, '7', 0)] } }
      }
      if (filter.programId !== undefined) return new Response('forbidden', { status: 403 })
      return { result: { value: [] } }
    })
    const result = await readSolanaBalances(SOL_OWNER)
    expect(result.complete).toBe(false)
    expect(result.tokens.find((t) => t.id === ODD_MINT)).toBeUndefined()
  })

  it('refuses an address that does not decode to 32 bytes', async () => {
    stubFetch(() => ({}))
    await expect(readSolanaBalances('a'.repeat(32))).rejects.toBeInstanceOf(ChainActionRefused)
  })

  it('does not answer once its deadline has passed', async () => {
    stubFetch(() => ({ result: { value: 1 } }))
    await expect(readSolanaBalances(SOL_OWNER, AbortSignal.abort())).rejects.toThrow()
  })

  it('throws rather than answer when the SOL balance cannot be read', async () => {
    stubFetch(() => new Response('nope', { status: 500 }))
    await expect(readSolanaBalances(SOL_OWNER)).rejects.toThrow()
  })

  it('refuses a malformed account', async () => {
    stubFetch(() => ({}))
    await expect(readSolanaBalances('not an address')).rejects.toBeInstanceOf(ChainActionRefused)
  })
})

describe('Sui balances', () => {
  const page = (nodes: unknown[], next?: string) => ({
    data: {
      address: {
        balances: {
          pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? null },
          nodes,
        },
      },
    },
  })
  const node = (repr: string, totalBalance: string) => ({ coinType: { repr }, totalBalance })

  it('reads address.balances, naming an unlisted coin by its last segment', async () => {
    stubFetch((_url, body) => {
      const q = (body as { query: string }).query
      if (q.includes('coinMetadata')) return { data: { a0: { decimals: 9, symbol: 'WAL' } } }
      return page([
        node(`0x${'0'.repeat(63)}2::sui::SUI`, '1031937015'),
        node(SUI_USDC, '304803'),
        node(WAL, '1500000'),
      ])
    })
    const result = await readSuiBalances(SUI_OWNER)
    expect(result.complete).toBe(true)
    expect(result.tokens).toContainEqual(
      expect.objectContaining({ symbol: 'SUI', amount: '1.031937015', native: true, listed: true })
    )
    expect(result.tokens).toContainEqual(
      expect.objectContaining({ symbol: 'USDC', amount: '0.304803', listed: true })
    )
    expect(result.tokens).toContainEqual(
      expect.objectContaining({ symbol: 'WAL', id: WAL, amount: '0.0015', listed: false })
    )
  })

  it('leaves out an unlisted coin whose decimals are unknown, and says the list is incomplete', async () => {
    stubFetch((_url, body) => {
      const q = (body as { query: string }).query
      if (q.includes('coinMetadata')) return { data: { a0: null } }
      return page([node(WAL, '1500000')])
    })
    const result = await readSuiBalances(SUI_OWNER)
    expect(result.tokens.find((t) => t.id === WAL)).toBeUndefined()
    expect(result.complete).toBe(false)
  })

  it('follows pagination', async () => {
    let n = 0
    stubFetch((_url, body) => {
      const q = (body as { query: string }).query
      if (q.includes('coinMetadata')) return { data: {} }
      n += 1
      return n === 1
        ? page([node('0x2::sui::SUI', '1')], 'cursor1')
        : page([node(SUI_USDC, '2000000')])
    })
    const result = await readSuiBalances(SUI_OWNER)
    expect(result.tokens.map((t) => t.symbol).sort()).toEqual(['SUI', 'USDC'])
    expect((calls[1]?.body as { variables: { c?: string } }).variables.c).toBe('cursor1')
  })

  it('says the list is incomplete when the page bound is hit', async () => {
    stubFetch((_url, body) => {
      const q = (body as { query: string }).query
      if (q.includes('coinMetadata')) return { data: {} }
      return page([node(SUI_USDC, '2000000')], 'more')
    })
    const result = await readSuiBalances(SUI_OWNER)
    expect(result.complete).toBe(false)
    const reads = calls.filter((c) => !(c.body as { query: string }).query.includes('coinMetadata'))
    expect(reads).toHaveLength(5)
  })

  it('does not call the list incomplete over a zero coin with unknown decimals', async () => {
    stubFetch((_url, body) => {
      const q = (body as { query: string }).query
      if (q.includes('coinMetadata')) return { data: { a0: null } }
      return page([node(WAL, '0')])
    })
    const result = await readSuiBalances(SUI_OWNER)
    expect(result.complete).toBe(true)
  })

  it('throws when GraphQL fails', async () => {
    stubFetch(() => new Response('down', { status: 502 }))
    await expect(readSuiBalances(SUI_OWNER)).rejects.toThrow()
  })

  it('refuses a malformed account', async () => {
    await expect(readSuiBalances('0x12')).rejects.toBeInstanceOf(ChainActionRefused)
  })
})

describe('NEAR balances', () => {
  const USDC_NEAR = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
  const viewAccount = { result: { amount: '2500000000000000000000000', storage_usage: 1000 } }
  const callResult = (value: unknown) => ({
    result: { result: Array.from(Buffer.from(JSON.stringify(value))) },
  })
  interface Rpc {
    params: { request_type: string; account_id: string; method_name: string; finality: string }
  }
  const list = (tokens: unknown[]) => ({ account_id: 'alice.near', tokens })

  function chain(
    fast: () => unknown,
    held: Record<string, string> = {},
    onCall?: (b: Rpc) => unknown
  ) {
    return (url: string, body: unknown) => {
      if (url.includes('fastnear.com/v1')) return fast()
      const b = body as Rpc
      if (b.params.request_type === 'view_account') return viewAccount
      const custom = onCall?.(b)
      if (custom !== undefined) return custom
      if (b.params.method_name === 'ft_balance_of') {
        return callResult(held[b.params.account_id] ?? '0')
      }
      return callResult({ symbol: 'EXA', decimals: 3 })
    }
  }

  it('reads table tokens on chain, and unlisted ones from FastNEAR with metadata', async () => {
    stubFetch(
      chain(
        () =>
          list([
            { contract_id: 'token.example.near', last_update_block_height: 1, balance: '42000' },
            { contract_id: 'empty.near', last_update_block_height: 1, balance: '0' },
          ]),
        { [USDC_NEAR]: '3000000' }
      )
    )
    const result = await readNearBalances('alice.near')
    expect(result.complete).toBe(true)
    expect(result.tokens).toContainEqual(
      expect.objectContaining({ symbol: 'NEAR', amount: '2.5', native: true })
    )
    expect(result.tokens).toContainEqual(
      expect.objectContaining({ symbol: 'USDC', amount: '3', listed: true })
    )
    expect(result.tokens).toContainEqual(
      expect.objectContaining({
        symbol: 'EXA',
        id: 'token.example.near',
        amount: '42',
        listed: false,
      })
    )
    expect(result.tokens.find((t) => t.id === 'empty.near')).toBeUndefined()
  })

  it('shows a token FastNEAR has not indexed yet, read at finality final', async () => {
    const finalities: string[] = []
    stubFetch(
      chain(
        () => list([]),
        { [USDC_NEAR]: '5000000' },
        (b) => {
          finalities.push(b.params.finality)
          return undefined
        }
      )
    )
    const result = await readNearBalances('alice.near')
    expect(result.complete).toBe(true)
    expect(result.tokens.find((t) => t.symbol === 'USDC')?.amount).toBe('5')
    expect(finalities.length).toBeGreaterThan(0)
    expect(finalities.every((f) => f === 'final')).toBe(true)
  })

  it('throws when a table token cannot be read, rather than reading zero', async () => {
    stubFetch(
      chain(
        () => list([]),
        {},
        (b) => (b.params.account_id === USDC_NEAR ? { error: { name: 'UNKNOWN' } } : undefined)
      )
    )
    await expect(readNearBalances('alice.near')).rejects.toThrow()
  })

  it('gives the table tokens with complete false when FastNEAR fails', async () => {
    stubFetch(chain(() => new Response('x', { status: 500 }), { [USDC_NEAR]: '1000000' }))
    const result = await readNearBalances('alice.near')
    expect(result.complete).toBe(false)
    expect(result.tokens.find((t) => t.symbol === 'USDC')?.amount).toBe('1')
    expect(result.tokens.find((t) => t.native)?.amount).toBe('2.5')
  })

  it('caps metadata reads at 20 and says the list is incomplete', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      contract_id: `t${i}.near`,
      last_update_block_height: 1,
      balance: '1000',
    }))
    stubFetch(chain(() => list(many)))
    const result = await readNearBalances('alice.near')
    expect(result.complete).toBe(false)
    expect(result.tokens.filter((t) => !t.listed && !t.native)).toHaveLength(20)
  })

  it('refuses a malformed account', async () => {
    await expect(readNearBalances('Not Valid!')).rejects.toBeInstanceOf(ChainActionRefused)
  })
})

describe('EVM balances', () => {
  function client(): EvmClient & { read: string[] } {
    const read: string[] = []
    return {
      read,
      tokenBalance: async (token) => {
        read.push(token)
        return BigInt(2500000)
      },
      nativeBalance: async () => BigInt('1500000000000000000'),
      waitForReceipt: async () => {
        throw new Error('unused')
      },
      transaction: async () => {
        throw new Error('unused')
      },
    }
  }

  it('reads native and each table token and is never complete', async () => {
    const c = client()
    const result = await readEvmBalances('avalanche', EVM_OWNER, c)
    expect(result.complete).toBe(false)
    expect(result.knownOnly).toBe(true)
    expect(result.tokens).toContainEqual(
      expect.objectContaining({ symbol: 'AVAX', amount: '1.5', native: true })
    )
    expect(result.tokens).toContainEqual(
      expect.objectContaining({ symbol: 'USDC', amount: '2.5', listed: true })
    )
    expect(c.read).toHaveLength(AVALANCHE_TOKENS.length - 1)
  })

  it('never reads Monad table tokens on Avalanche', async () => {
    const c = client()
    await readEvmBalances('avalanche', EVM_OWNER, c)
    for (const t of MONAD_TOKENS) expect(c.read).not.toContain(t.id)
    const m = client()
    await readEvmBalances('monad', EVM_OWNER, m)
    for (const t of AVALANCHE_TOKENS) expect(m.read).not.toContain(t.id)
  })

  it('throws when a read fails', async () => {
    const c = client()
    c.tokenBalance = async () => {
      throw new Error('rpc down')
    }
    await expect(readEvmBalances('monad', EVM_OWNER, c)).rejects.toThrow()
  })

  it('refuses a malformed account', async () => {
    await expect(readEvmBalances('monad', '0x12', client())).rejects.toBeInstanceOf(
      ChainActionRefused
    )
  })
})

describe('balanceReplyIsCurrent', () => {
  const asked = { chain: 'solana', account: 'A', turn: 3 }

  it('keeps a reply when nothing changed', () => {
    expect(balanceReplyIsCurrent(asked, { ...asked })).toBe(true)
  })

  it('drops it when another wallet connected', () => {
    expect(balanceReplyIsCurrent(asked, { ...asked, account: 'B' })).toBe(false)
  })

  it('drops it when the chain changed', () => {
    expect(balanceReplyIsCurrent(asked, { ...asked, chain: 'sui' })).toBe(false)
  })

  it('drops it when a newer message was sent', () => {
    expect(balanceReplyIsCurrent(asked, { ...asked, turn: 4 })).toBe(false)
  })

  it('drops it when the wallet disconnected', () => {
    expect(balanceReplyIsCurrent(asked, { ...asked, account: undefined })).toBe(false)
  })
})

describe('balanceReplyDecision', () => {
  const asked = { chain: 'solana', account: 'A', turn: 3 }

  it('shows the reply when nothing changed', () => {
    expect(balanceReplyDecision(asked, { ...asked })).toEqual({ kind: 'show' })
  })

  it('tells the person to ask again when the wallet changed and they sent nothing since', () => {
    expect(balanceReplyDecision(asked, { ...asked, account: 'B' })).toEqual({
      kind: 'notice',
      text: WALLET_CHANGED_NOTICE,
    })
    expect(balanceReplyDecision(asked, { ...asked, chain: 'sui' }).kind).toBe('notice')
    expect(WALLET_CHANGED_NOTICE).toBe('Your wallet changed, so ask again for its balance.')
  })

  it('says nothing when a newer message was sent or the chat was cleared', () => {
    expect(balanceReplyDecision(asked, { ...asked, turn: 4 })).toEqual({ kind: 'drop' })
    expect(balanceReplyDecision(asked, { ...asked, turn: 4, account: 'B' })).toEqual({
      kind: 'drop',
    })
  })
})

describe('chain balances route', () => {
  it('is bounded to 20 seconds', async () => {
    const route = await import('../../app/api/chain/[chain]/balances/route')
    expect(route.maxDuration).toBe(20)
  })
})

describe('chainBalanceReply', () => {
  const t = (over: Partial<TokenBalance> & { symbol: string }): TokenBalance => ({
    id: over.symbol,
    amount: '1',
    decimals: 6,
    native: false,
    listed: true,
    ...over,
  })
  const wallet = (tokens: TokenBalance[], complete = true): WalletBalances => ({
    tokens,
    complete,
  })

  it('lists native first, then listed, then unlisted with the shortened id', () => {
    const reply = chainBalanceReply(
      wallet([
        t({ symbol: ODD_MINT, id: ODD_MINT, amount: '7', listed: false }),
        t({ symbol: 'USDC', amount: '2' }),
        t({ symbol: 'SOL', amount: '0.01477', native: true }),
      ]),
      'Solana'
    )
    const lines = reply.split('\n')
    expect(lines[0]).toBe('Your wallet holds:')
    expect(lines[1]).toBe('• 0.01477 SOL')
    expect(lines[2]).toBe('• 2 USDC')
    expect(lines[3]).toBe('• 7 AbCd…StUv')
    expect(reply).not.toContain('Only tokens')
  })

  it('drops zero balances except native', () => {
    const reply = chainBalanceReply(
      wallet([
        t({ symbol: 'SOL', amount: '0', native: true }),
        t({ symbol: 'USDC', amount: '0' }),
        t({ symbol: 'USDT', amount: '3' }),
      ]),
      'Solana'
    )
    expect(reply).toContain('• 0 SOL')
    expect(reply).not.toContain('USDC')
    expect(reply).toContain('• 3 USDT')
  })

  it('ends with "and N more" past 30 tokens', () => {
    const many = Array.from({ length: 35 }, (_, i) => t({ symbol: `T${i}`, id: `T${i}` }))
    const reply = chainBalanceReply(wallet(many), 'Sui')
    expect(reply.split('\n').filter((l) => l.startsWith('•'))).toHaveLength(30)
    expect(reply).toContain('and 5 more')
  })

  it('says only known tokens are shown when an EVM chain is incomplete', () => {
    const reply = chainBalanceReply(
      { ...wallet([t({ symbol: 'AVAX', native: true })], false), knownOnly: true },
      'Avalanche'
    )
    expect(reply).toContain('Only tokens Intent knows on Avalanche are shown.')
  })

  it('says some tokens could not be read, not that only known ones are shown, elsewhere', () => {
    const reply = chainBalanceReply(wallet([t({ symbol: 'SUI', native: true })], false), 'Sui')
    expect(reply).toContain('Some tokens could not be read.')
    expect(reply).not.toContain('Only tokens')
  })

  it('never gives a number when nothing was read', () => {
    const reply = chainBalanceReply(undefined, 'Solana')
    expect(reply).toBe(
      "I could not read your balance just now, so I won't guess. Try again in a moment."
    )
    expect(reply).not.toMatch(/\d/)
  })
})
