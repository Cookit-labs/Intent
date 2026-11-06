import {
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  type Address,
} from '@solana/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  KAMINO_HOLDER,
  KAMINO_VAULT,
  KAMINO_WITHDRAW_FROM_RESERVE_TEN_SHARES,
  KAMINO_WITHDRAW_ONE_SHARE,
  KAMINO_WITHDRAW_WHOLE,
  LULO_HOLDER,
  LULO_WITHDRAW_ONE,
  LULO_WITHDRAW_WHOLE,
  RESERVE_HOLDER,
} from '../chains/solana/__fixtures__/captured-exits'
import {
  CAPTURE_ACCOUNT,
  JUPITER_LEND_USDC_DEPOSIT,
  KAMINO_USDC_DEPOSIT,
  LULO_USDC_DEPOSIT,
} from '../chains/solana/__fixtures__/captured-transactions'
import {
  assertExitAmount,
  associatedTokenAccount,
  decodeSolanaTransaction,
} from '../chains/solana/assert-safe'
import { createJupiterLendVenue } from '../chains/solana/jupiter-lend'
import { createKaminoVenue } from '../chains/solana/kamino'
import { createLuloVenue } from '../chains/solana/lulo'
import {
  JUPITER_LEND_ADMIN,
  JUPITER_LEND_MARKETS,
  JUPITER_LEND_PROGRAM,
  JUPITER_LIQUIDITY,
  JUPITER_LIQUIDITY_PROGRAM,
  KAMINO_EXIT_POLICY,
  KVAULT_GLOBAL_CONFIG,
  KVAULT_PROGRAM,
  KFARMS_PROGRAM,
  WITHDRAW_DISCRIMINATOR,
} from '../chains/solana/programs'
import type { SolanaRpc } from '../chains/solana/stake-pool'
import { ChainActionRefused, type SigningPayload } from '../chains/types'

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
const WALLET = 'HFqp6ErWHY6Uzhj8rFyjYuDya2mXUpYEk8VW75K9PSiY'
const ATTACKER = 'BPFLoaderUpgradeab1e11111111111111111111111'
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'
const U64_MAX = BigInt('18446744073709551615')

const addressBytes = (address: string): Uint8Array =>
  Uint8Array.from(getAddressEncoder().encode(address as Address))

function le(value: bigint, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes)
  let rest = value
  for (let i = 0; i < bytes; i += 1) {
    out[i] = Number(rest & BigInt(255))
    rest >>= BigInt(8)
  }
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function tokenAccount(mint: string, owner: string, amount: bigint): Uint8Array {
  return concat(addressBytes(mint), addressBytes(owner), le(amount, 8), new Uint8Array(165 - 72))
}

function chainAccount(owner: string, data: Uint8Array) {
  return {
    owner,
    lamports: 1,
    data: [Buffer.from(data).toString('base64'), 'base64'] as const,
  }
}

/** A node that answers from a table of accounts. Anything else it is asked is a failure. */
function nodeWith(accounts: Record<string, ReturnType<typeof chainAccount>>): SolanaRpc {
  return async (method, params) => {
    if (method === 'getLatestBlockhash') {
      return { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } }
    }
    if (method === 'getMultipleAccounts') {
      return { value: (params[0] as string[]).map((address) => accounts[address] ?? null) }
    }
    throw new Error(`unexpected ${method}`)
  }
}

const downNode: SolanaRpc = async () => {
  throw new ChainActionRefused('Solana’s network could not be read just now.')
}

interface Message {
  version: number | 'legacy'
  header: { numSignerAccounts: number }
  staticAccounts: readonly Address[]
  lifetimeToken: string
  instructions: readonly {
    programAddressIndex: number
    accountIndices?: readonly number[]
    data?: Uint8Array
  }[]
}

function open(base64: string): Message {
  const { messageBytes } = getTransactionDecoder().decode(Buffer.from(base64, 'base64'))
  return getCompiledTransactionMessageDecoder().decode(messageBytes) as unknown as Message
}

function close(message: Message): string {
  const bytes = getCompiledTransactionMessageEncoder().encode(
    message as unknown as Parameters<
      ReturnType<typeof getCompiledTransactionMessageEncoder>['encode']
    >[0]
  )
  const signers = message.header.numSignerAccounts
  const unsigned = new Uint8Array(1 + signers * 64 + bytes.length)
  unsigned[0] = signers
  unsigned.set(bytes, 1 + signers * 64)
  return Buffer.from(unsigned).toString('base64')
}

function swapAccount(base64: string, from: string, to: string): string {
  const message = open(base64)
  expect(message.staticAccounts).toContain(from)
  return close({
    ...message,
    staticAccounts: message.staticAccounts.map((a) => (a === from ? (to as Address) : a)),
  } as Message)
}

/** Adds a plain token transfer of the signer's tokens to a transaction. */
function withTransfer(base64: string): string {
  const message = open(base64)
  const tokenIndex = message.staticAccounts.indexOf(TOKEN as Address)
  return close({
    ...message,
    instructions: [
      ...message.instructions,
      {
        programAddressIndex: tokenIndex,
        accountIndices: [1, 1, 0],
        data: Uint8Array.from([3, ...le(BigInt(1), 8)]),
      },
    ],
  } as Message)
}

const solana = (transaction: string): SigningPayload => ({ family: 'solana', transaction })

const usdcMarket = JUPITER_LEND_MARKETS[0]

function stubFetch(
  route: (url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined
): { calls: { url: string; body: unknown; headers: unknown }[] } {
  const calls: { url: string; body: unknown; headers: unknown }[] = []
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: init?.headers,
    })
    const answer = route(url, init)
    if (answer === undefined) throw new Error(`unexpected fetch ${url}`)
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 })
  })
  return { calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('jupiter lend pins', () => {
  it('derives every pinned address from the seeds in Jupiter’s docs', async () => {
    const encoder = getAddressEncoder()
    const lend = JUPITER_LEND_PROGRAM as Address
    const [admin] = await getProgramDerivedAddress({
      programAddress: lend,
      seeds: ['lending_admin'],
    })
    expect(admin).toBe(JUPITER_LEND_ADMIN)
    const [liquidity] = await getProgramDerivedAddress({
      programAddress: JUPITER_LIQUIDITY_PROGRAM as Address,
      seeds: ['liquidity'],
    })
    expect(liquidity).toBe(JUPITER_LIQUIDITY)
    expect(JUPITER_LEND_MARKETS.map((m) => m.mint)).toEqual([USDC, USDT])
    for (const market of JUPITER_LEND_MARKETS) {
      const mint = encoder.encode(market.mint as Address)
      const [receipt] = await getProgramDerivedAddress({
        programAddress: lend,
        seeds: ['f_token_mint', mint],
      })
      expect(receipt).toBe(market.receipt)
      const [pool] = await getProgramDerivedAddress({
        programAddress: lend,
        seeds: ['lending', mint, encoder.encode(receipt)],
      })
      expect(pool).toBe(market.pool)
    }
  })
})

describe('jupiter lend exit', () => {
  const RESERVES = '94vK29npVbyRHXH63rRcTiSr26SFhrQTzbpNJuhQEDu'
  const SUPPLY_POSITION = 'Hf9gtkM4dpVBahVSzEXSVCAPpKzBsBcns3s8As3z77oF'
  const REWARDS = '5xSPBiD3TibamAnwHDhZABdB4z4F9dcj5PnbteroBTTd'
  const PRICE = BigInt('1068357013115')
  const SHARES = BigInt(48_398_806)

  function poolBytes(market = usdcMarket as (typeof JUPITER_LEND_MARKETS)[number], mint?: string) {
    return concat(
      Uint8Array.from([135, 199, 82, 16, 249, 131, 182, 241]),
      addressBytes(mint ?? market.mint),
      addressBytes(market.receipt),
      le(BigInt(2), 2),
      Uint8Array.of(6),
      addressBytes(REWARDS),
      le(BigInt('1047874296785'), 8),
      le(PRICE, 8),
      le(BigInt(1793879576), 8),
      addressBytes(RESERVES),
      addressBytes(SUPPLY_POSITION),
      Uint8Array.of(255)
    )
  }

  function chain(shares: bigint = SHARES, pool: Uint8Array = poolBytes()) {
    const accounts: Record<string, ReturnType<typeof chainAccount>> = {
      [usdcMarket.pool]: chainAccount(JUPITER_LEND_PROGRAM, pool),
      [JUPITER_LEND_MARKETS[1].pool]: chainAccount(
        JUPITER_LEND_PROGRAM,
        poolBytes(JUPITER_LEND_MARKETS[1])
      ),
    }
    if (shares > BigInt(0)) {
      accounts[associatedTokenAccount(WALLET, usdcMarket.receipt)] = chainAccount(
        TOKEN,
        tokenAccount(usdcMarket.receipt, WALLET, shares)
      )
    }
    return nodeWith(accounts)
  }

  const withdraw = (amount: string, wholePosition?: boolean) =>
    ({
      kind: 'withdraw',
      amount,
      tokenIn: 'USDC',
      ...(wholePosition === undefined ? {} : { wholePosition }),
    }) as const

  async function built(amount: string, wholePosition?: boolean) {
    const venue = createJupiterLendVenue({ rpc: chain() })
    const prepared = await venue.prepare(withdraw(amount, wholePosition), WALLET)
    if (prepared.signing.family !== 'solana') throw new Error('Expected a Solana payload.')
    return { venue, prepared, transaction: prepared.signing.transaction }
  }

  function exitInstruction(transaction: string) {
    const decoded = decodeSolanaTransaction(transaction)
    const instruction = decoded.instructions.find(
      (i) => decoded.staticAccounts[i.programIndex] === JUPITER_LEND_PROGRAM
    )
    if (instruction === undefined) throw new Error('No withdrawal in this transaction.')
    return {
      data: Buffer.from(instruction.data),
      accounts: instruction.accounts.map((index) => decoded.staticAccounts[index]),
    }
  }

  it('turns shares into USDC at the pool’s rate, not one for one', async () => {
    const venue = createJupiterLendVenue({ rpc: chain() })
    expect(await venue.positions?.(WALLET)).toEqual([
      { slot: 'supplied', symbol: 'USDC', amount: '51.707203' },
    ])
  })

  it('reads as nothing when the account holds no shares', async () => {
    const venue = createJupiterLendVenue({ rpc: chain(BigInt(0)) })
    expect(await venue.positions?.(WALLET)).toEqual([])
  })

  it('throws, rather than reading as empty, when the chain can’t be read', async () => {
    const venue = createJupiterLendVenue({ rpc: downNode })
    await expect(venue.positions?.(WALLET)).rejects.toThrow(ChainActionRefused)
  })

  it('throws when a pool isn’t what is pinned', async () => {
    const venue = createJupiterLendVenue({ rpc: chain(SHARES, poolBytes(usdcMarket, USDT)) })
    await expect(venue.positions?.(WALLET)).rejects.toThrow(/doesn’t look as expected/)
  })

  it('builds the amount asked, paying the wallet’s own token account', async () => {
    const { venue, prepared, transaction } = await built('10.5')
    const { data, accounts } = exitInstruction(transaction)
    expect(data.subarray(0, 8).toString('hex')).toBe(WITHDRAW_DISCRIMINATOR)
    expect(data.readBigUInt64LE(8)).toBe(BigInt(10_500_000))
    expect(accounts[0]).toBe(WALLET)
    expect(accounts[1]).toBe(associatedTokenAccount(WALLET, usdcMarket.receipt))
    expect(accounts[2]).toBe(associatedTokenAccount(WALLET, USDC))
    expect(accounts).toHaveLength(18)
    expect(prepared).toMatchObject({
      kind: 'withdraw',
      pay: { amount: '10.5', symbol: 'USDC' },
      receive: { amount: '10.5', symbol: 'USDC', approximate: false },
    })
    expect(() => venue.assertSafe(prepared.signing, WALLET)).not.toThrow()
  })

  it('needs no company server: nothing is fetched to build a withdrawal', async () => {
    const { calls } = stubFetch(() => undefined)
    await built('1')
    expect(calls).toHaveLength(0)
  })

  it('empties a whole position with the program’s own everything value', async () => {
    const { venue, prepared, transaction } = await built('51.707203', true)
    expect(exitInstruction(transaction).data.readBigUInt64LE(8)).toBe(U64_MAX)
    expect(prepared.receive).toMatchObject({ amount: '51.707203', approximate: true })
    expect(() => venue.assertSafe(prepared.signing, WALLET)).not.toThrow()
  })

  it('refuses more than is held', async () => {
    await expect(built('52')).rejects.toThrow(/about 51.707203 USDC.*less than 52/)
  })

  it('refuses when nothing is held', async () => {
    const venue = createJupiterLendVenue({ rpc: chain(BigInt(0)) })
    await expect(venue.prepare(withdraw('1'), WALLET)).rejects.toThrow(/no USDC on Jupiter Lend/)
  })

  it('refuses a token it doesn’t pay back', async () => {
    const venue = createJupiterLendVenue({ rpc: chain() })
    await expect(
      venue.prepare({ kind: 'withdraw', amount: '1', tokenIn: 'SOL' }, WALLET)
    ).rejects.toThrow(/USDC or USDT, not SOL/)
  })

  it('still passes the deposits it builds', () => {
    const venue = createJupiterLendVenue({ rpc: chain() })
    expect(() => venue.assertSafe(solana(JUPITER_LEND_USDC_DEPOSIT), CAPTURE_ACCOUNT)).not.toThrow()
  })

  describe('a tampered withdrawal', () => {
    it('refuses another person’s token account as the recipient', async () => {
      const { venue, transaction } = await built('1')
      const tampered = swapAccount(transaction, associatedTokenAccount(WALLET, USDC), ATTACKER)
      expect(() => venue.assertSafe(solana(tampered), WALLET)).toThrow(ChainActionRefused)
    })

    it('refuses a shares account that isn’t the person’s', async () => {
      const { venue, transaction } = await built('1')
      const tampered = swapAccount(
        transaction,
        associatedTokenAccount(WALLET, usdcMarket.receipt),
        ATTACKER
      )
      expect(() => venue.assertSafe(solana(tampered), WALLET)).toThrow(ChainActionRefused)
    })

    it('refuses a transfer tucked in beside it', async () => {
      const { venue, transaction } = await built('1')
      expect(() => venue.assertSafe(solana(withTransfer(transaction)), WALLET)).toThrow(
        /moves or approves tokens/
      )
    })

    it('refuses being checked for a different signer', async () => {
      const { venue, prepared } = await built('1')
      expect(() => venue.assertSafe(prepared.signing, ATTACKER)).toThrow(/network fee/)
    })

    it('refuses a zero amount', async () => {
      const { venue, transaction } = await built('1')
      const message = open(transaction)
      const tampered = close({
        ...message,
        instructions: message.instructions.map((i) =>
          message.staticAccounts[i.programAddressIndex] === JUPITER_LEND_PROGRAM
            ? {
                ...i,
                data: Uint8Array.from([
                  ...Buffer.from(WITHDRAW_DISCRIMINATOR, 'hex'),
                  ...le(BigInt(0), 8),
                ]),
              }
            : i
        ),
      } as Message)
      expect(() => venue.assertSafe(solana(tampered), WALLET)).toThrow(ChainActionRefused)
    })

    it('refuses the redeem instruction, which only a deposit’s policy would ever see', async () => {
      const { venue, transaction } = await built('1')
      const message = open(transaction)
      const redeem = close({
        ...message,
        instructions: message.instructions.map((i) =>
          message.staticAccounts[i.programAddressIndex] === JUPITER_LEND_PROGRAM
            ? {
                ...i,
                data: Uint8Array.from(Buffer.from(`b80c569546c461e1${'00'.repeat(8)}`, 'hex')),
              }
            : i
        ),
      } as Message)
      expect(() => venue.assertSafe(solana(redeem), WALLET)).toThrow(ChainActionRefused)
    })
  })
})

describe('kamino exit', () => {
  const FARM = '9FVjHqduhDPMVqvu3cXiEBjU6nvxvGdCCLRwd9WpVRZj'
  const SHARES_MINT = '7D8C5pDFxug58L9zkwK7bCiDg4kD4AygzbcZUmf5usHS'
  const OTHER_VAULT = 'QAYtEKciq4gc42K683rTaWu3JxqceA7JkEkZxwWUWBo'
  const OTHER_SHARES_MINT = 'DgHN3q3dSYAchNX7V3D4aYiTWMx8RHTgHbfPiwiqBkE9'
  const NO_FARM = new Uint8Array(32)

  interface VaultSetup {
    mint?: string
    sharesMint?: string
    farm?: Uint8Array
    issued?: bigint
    aum?: bigint
    minWithdraw?: bigint
    penaltyLamports?: bigint
    penaltyBps?: bigint
    name?: string
  }

  /** A `VaultState` in its real layout, with one share worth `aum / issued` tokens. */
  function vaultBytes(setup: VaultSetup = {}): Uint8Array {
    const data = new Uint8Array(62552)
    data.set(addressBytes(setup.mint ?? USDC), 80)
    data.set(addressBytes(setup.sharesMint ?? SHARES_MINT), 184)
    data.set(le(BigInt(6), 8), 216)
    data.set(le(setup.issued ?? BigInt(1000), 8), 232)
    data.set(le((setup.aum ?? BigInt(1000)) << BigInt(60), 16), 280)
    data.set(le(setup.minWithdraw ?? BigInt(0), 8), 58416)
    data.set(new TextEncoder().encode(setup.name ?? 'Steakhouse USDC'), 58528)
    data.set(setup.farm ?? addressBytes(FARM), 58600)
    data.set(le(setup.penaltyLamports ?? BigInt(0), 8), 58680)
    data.set(le(setup.penaltyBps ?? BigInt(0), 8), 58688)
    return data
  }

  function globalBytes(lamports = BigInt(0), bps = BigInt(0)): Uint8Array {
    const data = new Uint8Array(1032)
    data.set(le(lamports, 8), 72)
    data.set(le(bps, 8), 80)
    return data
  }

  async function farmUserAddress(account: string, farm: string): Promise<string> {
    const encoder = getAddressEncoder()
    const [address] = await getProgramDerivedAddress({
      programAddress: KFARMS_PROGRAM as Address,
      seeds: ['user', encoder.encode(farm as Address), encoder.encode(account as Address)],
    })
    return address
  }

  function farmUserBytes(account: string, shares: bigint): Uint8Array {
    const data = new Uint8Array(920)
    data.set(addressBytes(account), 48)
    data.set(le(shares * BigInt(10) ** BigInt(18), 16), 408)
    return data
  }

  async function chain(
    account: string,
    options: {
      inWallet?: bigint
      staked?: bigint
      vault?: VaultSetup
      global?: Uint8Array
      extra?: Record<string, ReturnType<typeof chainAccount>>
    } = {}
  ) {
    const { inWallet = BigInt(0), staked = BigInt(0) } = options
    const sharesMint = options.vault?.sharesMint ?? SHARES_MINT
    return nodeWith({
      [KVAULT_GLOBAL_CONFIG]: chainAccount(KVAULT_PROGRAM, options.global ?? globalBytes()),
      [KAMINO_VAULT]: chainAccount(KVAULT_PROGRAM, vaultBytes(options.vault)),
      [associatedTokenAccount(account, sharesMint)]: chainAccount(
        TOKEN,
        tokenAccount(sharesMint, account, inWallet)
      ),
      [await farmUserAddress(account, FARM)]: chainAccount(
        KFARMS_PROGRAM,
        farmUserBytes(account, staked)
      ),
      ...options.extra,
    })
  }

  function kaminoApi(
    vaults: string[] = [KAMINO_VAULT],
    transaction: string = KAMINO_WITHDRAW_ONE_SHARE
  ) {
    return stubFetch((url) => {
      if (url.includes('/positions')) {
        return { body: vaults.map((vaultAddress) => ({ vaultAddress, totalShares: '1' })) }
      }
      if (url.includes('/ktx/kvault/withdraw')) return { body: { transaction } }
      return undefined
    })
  }

  const withdraw = (amount: string, wholePosition?: boolean) =>
    ({
      kind: 'withdraw',
      amount,
      tokenIn: 'USDC',
      ...(wholePosition === undefined ? {} : { wholePosition }),
    }) as const

  it('adds shares in the wallet and in the farm, and converts them at the vault’s rate', async () => {
    kaminoApi()
    const rpc = await chain(KAMINO_HOLDER, {
      inWallet: BigInt(1_000_000),
      staked: BigInt(3_000_000),
      vault: { issued: BigInt(1000), aum: BigInt(1100) },
    })
    expect(await createKaminoVenue({ rpc }).positions?.(KAMINO_HOLDER)).toEqual([
      { slot: 'supplied', symbol: 'USDC', amount: '4.4' },
    ])
  })

  it('shows what would actually arrive, after the charge read on chain', async () => {
    kaminoApi()
    const rpc = await chain(KAMINO_HOLDER, {
      inWallet: BigInt(1_000_000),
      global: globalBytes(BigInt(1000)),
    })
    expect(await createKaminoVenue({ rpc }).positions?.(KAMINO_HOLDER)).toEqual([
      { slot: 'supplied', symbol: 'USDC', amount: '0.999' },
    ])
  })

  it('reads a vault with no farm from the wallet alone', async () => {
    kaminoApi()
    const rpc = await chain(KAMINO_HOLDER, {
      inWallet: BigInt(2_000_000),
      vault: { farm: NO_FARM },
    })
    expect(await createKaminoVenue({ rpc }).positions?.(KAMINO_HOLDER)).toEqual([
      { slot: 'supplied', symbol: 'USDC', amount: '2' },
    ])
  })

  it('leaves out a vault of another token, or one not on Kamino’s program', async () => {
    kaminoApi([KAMINO_VAULT, OTHER_VAULT])
    const rpc = await chain(KAMINO_HOLDER, {
      inWallet: BigInt(1_000_000),
      vault: { mint: USDT },
      extra: { [OTHER_VAULT]: chainAccount(ATTACKER, vaultBytes()) },
    })
    expect(await createKaminoVenue({ rpc }).positions?.(KAMINO_HOLDER)).toEqual([])
  })

  it('reads as nothing when Kamino lists no vaults', async () => {
    kaminoApi([])
    const venue = createKaminoVenue({ rpc: downNode })
    expect(await venue.positions?.(KAMINO_HOLDER)).toEqual([])
  })

  it('throws when Kamino can’t say which vaults', async () => {
    stubFetch(() => ({ status: 500, body: {} }))
    const venue = createKaminoVenue({ rpc: downNode })
    await expect(venue.positions?.(KAMINO_HOLDER)).rejects.toThrow(ChainActionRefused)
  })

  it('throws when the chain can’t be read', async () => {
    kaminoApi()
    const venue = createKaminoVenue({ rpc: downNode })
    await expect(venue.positions?.(KAMINO_HOLDER)).rejects.toThrow(ChainActionRefused)
  })

  it('asks Kamino for the shares that pay the amount, and checks what comes back', async () => {
    const { calls } = kaminoApi()
    const rpc = await chain(KAMINO_HOLDER, { staked: BigInt(5_000_000) })
    const venue = createKaminoVenue({ rpc })
    const prepared = await venue.prepare(withdraw('1'), KAMINO_HOLDER)
    const asked = calls.find((c) => c.url.includes('/ktx/'))
    expect(asked?.body).toEqual({ wallet: KAMINO_HOLDER, kvault: KAMINO_VAULT, amount: '1' })
    expect(prepared).toMatchObject({ kind: 'withdraw', receive: { amount: '1', symbol: 'USDC' } })
    expect(prepared.summary).toContain('Steakhouse USDC')
    expect(prepared.notes.join(' ')).toMatch(/Kamino’s own server builds this/)
    expect(() => venue.assertSafe(prepared.signing, KAMINO_HOLDER)).not.toThrow()
  })

  it('refuses a build for a different amount', async () => {
    kaminoApi()
    const rpc = await chain(KAMINO_HOLDER, { staked: BigInt(5_000_000) })
    await expect(createKaminoVenue({ rpc }).prepare(withdraw('2'), KAMINO_HOLDER)).rejects.toThrow(
      /not the amount you asked for/
    )
  })

  it('refuses a build that doesn’t pay the person', async () => {
    const message = open(KAMINO_WITHDRAW_ONE_SHARE)
    const recipient = associatedTokenAccount(KAMINO_HOLDER, USDC)
    expect(message.staticAccounts).toContain(recipient)
    kaminoApi(undefined, swapAccount(KAMINO_WITHDRAW_ONE_SHARE, recipient, ATTACKER))
    const rpc = await chain(KAMINO_HOLDER, { staked: BigInt(5_000_000) })
    await expect(createKaminoVenue({ rpc }).prepare(withdraw('1'), KAMINO_HOLDER)).rejects.toThrow(
      /own token account/
    )
  })

  it('sends the program’s everything value for the whole of a position', async () => {
    const { calls } = kaminoApi(undefined, KAMINO_WITHDRAW_WHOLE)
    const rpc = await chain(KAMINO_HOLDER, { staked: BigInt(5_000_000) })
    const venue = createKaminoVenue({ rpc })
    const prepared = await venue.prepare(withdraw('5', true), KAMINO_HOLDER)
    expect(calls.find((c) => c.url.includes('/ktx/'))?.body).toMatchObject({
      amount: '18446744073709.551615',
    })
    expect(prepared.receive).toMatchObject({ amount: '5', approximate: true })
    expect(() => venue.assertSafe(prepared.signing, KAMINO_HOLDER)).not.toThrow()
  })

  it('counts a request for all of it as whole, once the shares reach what is held', async () => {
    const { calls } = kaminoApi(undefined, KAMINO_WITHDRAW_WHOLE)
    const rpc = await chain(KAMINO_HOLDER, { staked: BigInt(5_000_000) })
    await createKaminoVenue({ rpc }).prepare(withdraw('5'), KAMINO_HOLDER)
    expect(calls.find((c) => c.url.includes('/ktx/'))?.body).toMatchObject({
      amount: '18446744073709.551615',
    })
  })

  it('refuses a whole build that isn’t the everything value', async () => {
    kaminoApi(undefined, KAMINO_WITHDRAW_ONE_SHARE)
    const rpc = await chain(KAMINO_HOLDER, { staked: BigInt(5_000_000) })
    await expect(
      createKaminoVenue({ rpc }).prepare(withdraw('5', true), KAMINO_HOLDER)
    ).rejects.toThrow(/not the amount you asked for/)
  })

  describe('with two vaults', () => {
    async function twoVaults() {
      kaminoApi([KAMINO_VAULT, OTHER_VAULT], KAMINO_WITHDRAW_WHOLE)
      return chain(KAMINO_HOLDER, {
        staked: BigInt(1_000_000),
        extra: {
          [OTHER_VAULT]: chainAccount(
            KVAULT_PROGRAM,
            vaultBytes({ sharesMint: OTHER_SHARES_MINT, farm: NO_FARM, name: 'RWA USDC' })
          ),
          [associatedTokenAccount(KAMINO_HOLDER, OTHER_SHARES_MINT)]: chainAccount(
            TOKEN,
            tokenAccount(OTHER_SHARES_MINT, KAMINO_HOLDER, BigInt(9_000_000))
          ),
        },
      })
    }

    it('lists both, largest first, so "all" reads the one it would empty', async () => {
      const rpc = await twoVaults()
      expect(await createKaminoVenue({ rpc }).positions?.(KAMINO_HOLDER)).toEqual([
        { slot: 'supplied', symbol: 'USDC', amount: '9' },
        { slot: 'supplied', symbol: 'USDC', amount: '1' },
      ])
    })

    it('empties the largest and says the other is still there', async () => {
      const rpc = await twoVaults()
      const prepared = await createKaminoVenue({ rpc }).prepare(withdraw('9', true), KAMINO_HOLDER)
      expect(prepared.summary).toContain('RWA USDC')
      expect(prepared.notes.join(' ')).toMatch(
        /also have about 1 USDC in Kamino's "Steakhouse USDC"/
      )
    })

    it('refuses an amount no single vault holds, and names what can leave', async () => {
      const rpc = await twoVaults()
      await expect(
        createKaminoVenue({ rpc }).prepare(withdraw('10'), KAMINO_HOLDER)
      ).rejects.toThrow(/largest Kamino USDC vault holds about 9 USDC/)
    })
  })

  it('refuses when nothing is held', async () => {
    kaminoApi([])
    await expect(
      createKaminoVenue({ rpc: downNode }).prepare(withdraw('1'), KAMINO_HOLDER)
    ).rejects.toThrow(/no USDC on Kamino/)
  })

  describe('when the chain would reject what Kamino built', () => {
    function simulating(rpc: SolanaRpc, errors: unknown[]): SolanaRpc {
      return async (method, params) =>
        method === 'simulateTransaction'
          ? { value: { err: errors.shift() ?? null } }
          : rpc(method, params)
    }

    it('builds once more, since the vault’s cash moves within minutes', async () => {
      const { calls } = kaminoApi()
      const rpc = simulating(await chain(KAMINO_HOLDER, { staked: BigInt(5_000_000) }), [
        { InstructionError: [4, { Custom: 7004 }] },
      ])
      const prepared = await createKaminoVenue({ rpc }).prepare(withdraw('1'), KAMINO_HOLDER)
      expect(prepared.kind).toBe('withdraw')
      expect(calls.filter((c) => c.url.includes('/ktx/'))).toHaveLength(2)
    })

    it('refuses in plain words if that is rejected too, rather than cost a fee', async () => {
      const rejected = { InstructionError: [4, { Custom: 7004 }] }
      kaminoApi()
      const rpc = simulating(await chain(KAMINO_HOLDER, { staked: BigInt(5_000_000) }), [
        rejected,
        rejected,
      ])
      await expect(
        createKaminoVenue({ rpc }).prepare(withdraw('1'), KAMINO_HOLDER)
      ).rejects.toThrow(/can’t pay this out at the moment/)
    })

    it('lets a good exit through when the simulation itself can’t run', async () => {
      kaminoApi()
      const rpc = await chain(KAMINO_HOLDER, { staked: BigInt(5_000_000) })
      const prepared = await createKaminoVenue({ rpc }).prepare(withdraw('1'), KAMINO_HOLDER)
      expect(prepared.kind).toBe('withdraw')
    })
  })

  it('refuses at or under the vault’s least withdrawal, as the program would', async () => {
    kaminoApi()
    const rpc = await chain(KAMINO_HOLDER, {
      staked: BigInt(5_000_000),
      vault: { minWithdraw: BigInt(1_000_000) },
    })
    await expect(createKaminoVenue({ rpc }).prepare(withdraw('1'), KAMINO_HOLDER)).rejects.toThrow(
      /only pays out more than 1 USDC/
    )
  })

  it('refuses a token it doesn’t pay back', async () => {
    await expect(
      createKaminoVenue({ rpc: downNode }).prepare(
        { kind: 'withdraw', amount: '1', tokenIn: 'SOL' },
        KAMINO_HOLDER
      )
    ).rejects.toThrow(/USDC only, not SOL/)
  })

  describe('the proof over what Kamino’s API built', () => {
    const safe = createKaminoVenue({ rpc: downNode }).assertSafe

    it.each([
      ['from what the vault has free, unstaking first', KAMINO_WITHDRAW_ONE_SHARE, KAMINO_HOLDER],
      ['of a whole position, closing the emptied account', KAMINO_WITHDRAW_WHOLE, KAMINO_HOLDER],
      ['drawing on a lending market', KAMINO_WITHDRAW_FROM_RESERVE_TEN_SHARES, RESERVE_HOLDER],
    ])('passes a withdrawal %s', (_, transaction, holder) => {
      expect(() => safe(solana(transaction), holder)).not.toThrow()
    })

    it('still passes a deposit, and holds it to the deposit’s own rules', () => {
      expect(() => safe(solana(KAMINO_USDC_DEPOSIT), CAPTURE_ACCOUNT)).not.toThrow()
    })

    it('refuses another person’s token account as the recipient', () => {
      const tampered = swapAccount(
        KAMINO_WITHDRAW_ONE_SHARE,
        associatedTokenAccount(KAMINO_HOLDER, USDC),
        ATTACKER
      )
      expect(() => safe(solana(tampered), KAMINO_HOLDER)).toThrow(/own token account/)
    })

    it('refuses unstaked shares paid anywhere but the account the withdrawal burns', () => {
      const message = open(KAMINO_WITHDRAW_ONE_SHARE)
      const recipient = message.staticAccounts.indexOf(
        associatedTokenAccount(KAMINO_HOLDER, USDC) as Address
      )
      const tampered = close({
        ...message,
        instructions: message.instructions.map((i) =>
          (i.data ?? new Uint8Array()).length === 8 &&
          message.staticAccounts[i.programAddressIndex] === KFARMS_PROGRAM
            ? {
                ...i,
                accountIndices: (i.accountIndices ?? []).map((index, at) =>
                  at === 3 ? recipient : index
                ),
              }
            : i
        ),
      } as Message)
      expect(() => safe(solana(tampered), KAMINO_HOLDER)).toThrow(/can’t confirm is yours/)
    })

    it('refuses closing any token account but the emptied shares account', () => {
      const message = open(KAMINO_WITHDRAW_WHOLE)
      const recipient = message.staticAccounts.indexOf(
        associatedTokenAccount(KAMINO_HOLDER, USDC) as Address
      )
      const tampered = close({
        ...message,
        instructions: message.instructions.map((i) =>
          message.staticAccounts[i.programAddressIndex] === TOKEN
            ? {
                ...i,
                accountIndices: (i.accountIndices ?? []).map((index, at) =>
                  at === 0 ? recipient : index
                ),
              }
            : i
        ),
      } as Message)
      expect(() => safe(solana(tampered), KAMINO_HOLDER)).toThrow(/closes a token account/)
    })

    it('refuses a close that pays someone else the rent', () => {
      const message = open(KAMINO_WITHDRAW_WHOLE)
      const recipient = message.staticAccounts.indexOf(
        associatedTokenAccount(KAMINO_HOLDER, USDC) as Address
      )
      const tampered = close({
        ...message,
        instructions: message.instructions.map((i) =>
          message.staticAccounts[i.programAddressIndex] === TOKEN
            ? {
                ...i,
                accountIndices: (i.accountIndices ?? []).map((index, at) =>
                  at === 1 ? recipient : index
                ),
              }
            : i
        ),
      } as Message)
      expect(() => safe(solana(tampered), KAMINO_HOLDER)).toThrow(/does not pay you back/)
    })

    it('refuses a transfer tucked in beside it', () => {
      expect(() => safe(solana(withTransfer(KAMINO_WITHDRAW_WHOLE)), KAMINO_HOLDER)).toThrow(
        /moves tokens outside/
      )
    })

    it('refuses a program that isn’t part of the withdrawal', () => {
      const message = open(KAMINO_WITHDRAW_ONE_SHARE)
      const tampered = close({
        ...message,
        staticAccounts: message.staticAccounts.map((a) =>
          a === KVAULT_PROGRAM ? ('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' as Address) : a
        ),
      } as Message)
      expect(() => safe(solana(tampered), KAMINO_HOLDER)).toThrow(ChainActionRefused)
    })

    it('binds the amount: the sum paid out, or the everything value and nothing less', () => {
      const { rules } = KAMINO_EXIT_POLICY
      expect(() =>
        assertExitAmount(KAMINO_WITHDRAW_ONE_SHARE, rules, BigInt(1_000_000))
      ).not.toThrow()
      expect(() => assertExitAmount(KAMINO_WITHDRAW_ONE_SHARE, rules, BigInt(999_999))).toThrow(
        ChainActionRefused
      )
      expect(() => assertExitAmount(KAMINO_WITHDRAW_ONE_SHARE, rules, U64_MAX)).toThrow(
        ChainActionRefused
      )
      expect(() => assertExitAmount(KAMINO_WITHDRAW_WHOLE, rules, U64_MAX)).not.toThrow()
      expect(() => assertExitAmount(KAMINO_WITHDRAW_WHOLE, rules, BigInt(1_000_000))).toThrow(
        ChainActionRefused
      )
    })
  })
})

describe('lulo exit', () => {
  const venue = () => createLuloVenue({ apiKey: 'lulo-key' })

  function luloApi(
    options: { maxWithdrawable?: number; transaction?: string; status?: number } = {}
  ) {
    return stubFetch((url) => {
      if (url.includes('account.getAccount')) {
        return {
          status: options.status ?? 200,
          body: {
            maxWithdrawable: {
              protected: { [USDC]: options.maxWithdrawable ?? 3579.6813034693546 },
              regular: { [USDC]: 3.7e-13 },
            },
          },
        }
      }
      if (url.includes('generate.transactions.withdrawProtected')) {
        return { body: { transaction: options.transaction ?? LULO_WITHDRAW_ONE } }
      }
      return undefined
    })
  }

  const withdraw = (amount: string, wholePosition?: boolean) =>
    ({
      kind: 'withdraw',
      amount,
      tokenIn: 'USDC',
      ...(wholePosition === undefined ? {} : { wholePosition }),
    }) as const

  it('reads what can leave, in six places, with the key', async () => {
    const { calls } = luloApi()
    expect(await venue().positions?.(LULO_HOLDER)).toEqual([
      { slot: 'supplied', symbol: 'USDC', amount: '3579.681303' },
    ])
    expect(calls[0]?.headers).toMatchObject({ 'x-api-key': 'lulo-key' })
  })

  it('counts a floating-point crumb as nothing', async () => {
    luloApi({ maxWithdrawable: 3.7e-13 })
    expect(await venue().positions?.(LULO_HOLDER)).toEqual([])
  })

  it('throws, rather than reading as empty, when Lulo won’t answer', async () => {
    luloApi({ status: 401 })
    await expect(venue().positions?.(LULO_HOLDER)).rejects.toThrow(ChainActionRefused)
  })

  it('builds the amount asked and proves it pays the person', async () => {
    const { calls } = luloApi()
    const prepared = await venue().prepare(withdraw('1'), LULO_HOLDER)
    expect(calls.find((c) => c.url.includes('withdrawProtected'))?.body).toEqual({
      owner: LULO_HOLDER,
      mintAddress: USDC,
      amount: 1,
    })
    expect(prepared).toMatchObject({
      kind: 'withdraw',
      receive: { amount: '1', symbol: 'USDC', approximate: false },
    })
    expect(() => venue().assertSafe(prepared.signing, LULO_HOLDER)).not.toThrow()
  })

  it('empties a whole position by asking for more than it could hold', async () => {
    const { calls } = luloApi({ transaction: LULO_WITHDRAW_WHOLE })
    const prepared = await venue().prepare(withdraw('3579.681303', true), LULO_HOLDER)
    expect(calls.find((c) => c.url.includes('withdrawProtected'))?.body).toMatchObject({
      amount: 99_999_999,
    })
    expect(prepared.receive).toMatchObject({ amount: '3579.681303', approximate: true })
    expect(prepared.notes.join(' ')).toMatch(/asks for more than you hold/)
    expect(() => venue().assertSafe(prepared.signing, LULO_HOLDER)).not.toThrow()
  })

  it('refuses more than can leave, since the program would quietly pay less', async () => {
    luloApi({ maxWithdrawable: 0.5 })
    await expect(venue().prepare(withdraw('1'), LULO_HOLDER)).rejects.toThrow(
      /0.5 USDC.*less than 1/
    )
  })

  it('refuses a build for a different amount', async () => {
    luloApi({ transaction: LULO_WITHDRAW_ONE })
    await expect(venue().prepare(withdraw('2'), LULO_HOLDER)).rejects.toThrow(
      /not the amount you asked for/
    )
  })

  it('refuses a build that pays someone else', async () => {
    const tampered = swapAccount(
      LULO_WITHDRAW_ONE,
      associatedTokenAccount(LULO_HOLDER, USDC),
      ATTACKER
    )
    luloApi({ transaction: tampered })
    await expect(venue().prepare(withdraw('1'), LULO_HOLDER)).rejects.toThrow(/own token account/)
  })

  it('refuses when Lulo’s own simulation failed', async () => {
    stubFetch((url) =>
      url.includes('account.getAccount')
        ? { body: { maxWithdrawable: { protected: { [USDC]: 5 } } } }
        : { body: { transaction: LULO_WITHDRAW_ONE, simulateError: 'InsufficientFunds' } }
    )
    await expect(venue().prepare(withdraw('1'), LULO_HOLDER)).rejects.toThrow(/would fail/)
  })

  it('refuses when no transaction comes back', async () => {
    stubFetch((url) =>
      url.includes('account.getAccount')
        ? { body: { maxWithdrawable: { protected: { [USDC]: 5 } } } }
        : { status: 401, body: {} }
    )
    await expect(venue().prepare(withdraw('1'), LULO_HOLDER)).rejects.toThrow(
      /could not build this withdrawal/
    )
  })

  it('refuses a token it doesn’t pay back', async () => {
    await expect(
      venue().prepare({ kind: 'withdraw', amount: '1', tokenIn: 'SOL' }, LULO_HOLDER)
    ).rejects.toThrow(/USDC only, not SOL/)
  })

  it('refuses another person’s token account at submit, and a transfer beside it', () => {
    const safe = venue().assertSafe
    const tampered = swapAccount(
      LULO_WITHDRAW_ONE,
      associatedTokenAccount(LULO_HOLDER, USDC),
      ATTACKER
    )
    expect(() => safe(solana(tampered), LULO_HOLDER)).toThrow(/own token account/)
    const message = open(LULO_WITHDRAW_ONE)
    const budget = message.staticAccounts.indexOf(COMPUTE_BUDGET as Address)
    const withExtra = close({
      ...message,
      instructions: [
        ...message.instructions,
        {
          programAddressIndex: budget,
          accountIndices: [],
          data: Uint8Array.from([3, ...le(BigInt('999999999999'), 8)]),
        },
      ],
    } as Message)
    expect(() => safe(solana(withExtra), LULO_HOLDER)).toThrow(/priority fee/)
  })

  it('still passes a deposit, and refuses Kamino’s withdrawal', () => {
    const safe = venue().assertSafe
    expect(() => safe(solana(LULO_USDC_DEPOSIT), CAPTURE_ACCOUNT)).not.toThrow()
    expect(() => safe(solana(KAMINO_WITHDRAW_ONE_SHARE), KAMINO_HOLDER)).toThrow(ChainActionRefused)
  })
})
