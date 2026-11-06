import { TransactionExecutionError, UserRejectedRequestError, custom } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChainActionRefused, type SigningPayload } from '../chains/types'
import {
  avalancheClient,
  avalancheDeposit,
  createAvalancheDeposit,
  type AvalancheClient,
  type DepositReceipt,
} from '../weave/deposit/avalanche'
import type { DepositExpectation } from '../weave/types'

const wallet = vi.hoisted(() => ({
  account: { status: 'connected', chainId: 43114 } as {
    status: string
    chainId: number | undefined
  },
  calls: [] as unknown[][],
  sendError: undefined as unknown,
  switchError: undefined as unknown,
}))

vi.mock('wagmi/actions', () => ({
  getAccount: () => wallet.account,
  switchChain: async (_config: unknown, args: unknown) => {
    wallet.calls.push(['switch', args])
    if (wallet.switchError !== undefined) throw wallet.switchError
    return { id: 43114 }
  },
  sendTransaction: async (_config: unknown, args: unknown) => {
    wallet.calls.push(['send', args])
    if (wallet.sendError !== undefined) throw wallet.sendError
    return HASH_FROM_WALLET
  },
}))
vi.mock('../wagmi.config', () => ({ arcTestnet: { id: 5042002 }, wagmiConfig: {} }))

const HASH_FROM_WALLET = `0x${'c'.repeat(64)}`

const USDC = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'
const OTHER_TOKEN = '0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664'
const ACCOUNT = '0x1111111111111111111111111111111111111111'
const DEPOSIT = '0x2222222222222222222222222222222222222222'
const OTHER = '0x3333333333333333333333333333333333333333'
const ZERO = '0x0000000000000000000000000000000000000000'
const HASH = `0x${'a'.repeat(64)}`
const AMOUNT_UNITS = BigInt(12_500_000)

const word = (hexDigits: string): string => hexDigits.padStart(64, '0')
const addressWord = (address: string): string => word(address.slice(2).toLowerCase())

// 12.5 USDC at six places is 12500000, which is 0xbebc20.
const TRANSFER_DATA = `0xa9059cbb${addressWord(DEPOSIT)}${word('bebc20')}`

const plain: DepositExpectation = {
  account: ACCOUNT,
  depositAddress: DEPOSIT,
  memo: undefined,
  amount: '12.5',
}

function payload(change: Partial<Extract<SigningPayload, { family: 'evm' }>> = {}): SigningPayload {
  return { family: 'evm', chainId: 43114, to: USDC, data: TRANSFER_DATA, value: '0', ...change }
}

function fakeClient(change: Partial<AvalancheClient> = {}): AvalancheClient {
  return {
    usdcBalance: async () => AMOUNT_UNITS,
    avaxBalance: async () => BigInt(1),
    waitForReceipt: async () => {
      throw new Error('no receipt was arranged for this test')
    },
    ...change,
  }
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

function transferLog(
  change: { address?: string; from?: string; to?: string; hexAmount?: string } = {}
): DepositReceipt['logs'][number] {
  return {
    address: change.address ?? USDC,
    blockHash: `0x${'b'.repeat(64)}`,
    blockNumber: BigInt(1),
    data: `0x${word(change.hexAmount ?? 'bebc20')}`,
    logIndex: 0,
    removed: false,
    topics: [
      TRANSFER_TOPIC,
      `0x${addressWord(change.from ?? ACCOUNT)}`,
      `0x${addressWord(change.to ?? DEPOSIT)}`,
    ],
    transactionHash: HASH,
    transactionIndex: 0,
  } as unknown as DepositReceipt['logs'][number]
}

function receipt(change: Partial<DepositReceipt> = {}): DepositReceipt {
  return {
    status: 'success',
    from: ACCOUNT,
    to: USDC,
    logs: [transferLog()],
    ...change,
  } as DepositReceipt
}

function refusalOf(run: () => unknown): Error {
  try {
    run()
  } catch (e) {
    return e as Error
  }
  throw new Error('expected a refusal, and nothing was refused')
}

function expectRefused(run: () => unknown, about: RegExp): void {
  const e = refusalOf(run)
  expect(e).toBeInstanceOf(ChainActionRefused)
  expect(e.message).toMatch(about)
  expect(e.message).toMatch(/Nothing was signed or sent\.$/)
}

afterEach(() => {
  vi.useRealTimers()
  wallet.account = { status: 'connected', chainId: 43114 }
  wallet.calls = []
  wallet.sendError = undefined
  wallet.switchError = undefined
})

describe('avalancheDeposit: what it says about itself', () => {
  it('carries six decimals and no memo', () => {
    expect(avalancheDeposit.chain).toBe('avalanche')
    expect(avalancheDeposit.usdcDecimals).toBe(6)
    expect(avalancheDeposit.supportsMemo).toBe(false)
  })

  it('takes addresses in any casing, even with a checksum that does not hold', () => {
    const badChecksum = '0xb97ef9EF8734C71904D8002F8b6Bc66Dd9c48a6F'
    expect(avalancheDeposit.isAccount(badChecksum)).toBe(true)
    expect(avalancheDeposit.isDepositAddress(badChecksum)).toBe(true)
    expect(avalancheDeposit.isDepositAddress(DEPOSIT)).toBe(true)
  })

  it('refuses what is not an address, and the zero address', () => {
    for (const check of [avalancheDeposit.isAccount, avalancheDeposit.isDepositAddress]) {
      expect(check(ZERO)).toBe(false)
      expect(check('')).toBe(false)
      expect(check('0x1234')).toBe(false)
      expect(check('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(false)
    }
  })

  it('refuses the USDC contract as a deposit address, in any casing', () => {
    expect(avalancheDeposit.isDepositAddress(USDC)).toBe(false)
    expect(avalancheDeposit.isDepositAddress(USDC.toLowerCase())).toBe(false)
  })
})

describe('avalancheDeposit.assertSafe', () => {
  it('admits exactly the transfer the order asked for', () => {
    expect(() => avalancheDeposit.assertSafe(payload(), plain)).not.toThrow()
  })

  it('compares the token contract without regard to casing', () => {
    expect(() =>
      avalancheDeposit.assertSafe(payload({ to: USDC.toLowerCase() }), plain)
    ).not.toThrow()
  })

  it('compares the recipient without regard to casing', () => {
    const mixed = '0xAbCdEf0123456789aBcDeF0123456789abcdef01'
    const data = `0xa9059cbb${addressWord(mixed)}${word('bebc20')}`
    expect(() =>
      avalancheDeposit.assertSafe(payload({ data }), { ...plain, depositAddress: mixed })
    ).not.toThrow()
  })

  it.each<[string, Partial<Extract<SigningPayload, { family: 'evm' }>>, RegExp]>([
    [
      'another recipient',
      { data: `0xa9059cbb${addressWord(OTHER)}${word('bebc20')}` },
      /deposit address/i,
    ],
    ['a larger amount', { data: `0xa9059cbb${addressWord(DEPOSIT)}${word('bebc21')}` }, /amount/i],
    ['a smaller amount', { data: `0xa9059cbb${addressWord(DEPOSIT)}${word('bebc1f')}` }, /amount/i],
    ['another token contract', { to: OTHER_TOKEN }, /USDC/],
    ['an approve', { data: `0x095ea7b3${addressWord(DEPOSIT)}${word('bebc20')}` }, /transfer/i],
    [
      'a transferFrom',
      {
        data: `0x23b872dd${addressWord(ACCOUNT)}${addressWord(DEPOSIT)}${word('bebc20')}`,
      },
      /transfer/i,
    ],
    ['bytes after the transfer', { data: `${TRANSFER_DATA}deadbeef` }, /extra|exactly/i],
    [
      'dirty padding before the address',
      { data: `0xa9059cbb${'f'.repeat(24)}${'2'.repeat(40)}${word('bebc20')}` },
      /extra|exactly/i,
    ],
    ['calldata cut short', { data: TRANSFER_DATA.slice(0, 40) }, /transfer/i],
    ['no calldata', { data: '0x' }, /transfer/i],
    ['text that is not calldata', { data: 'hello' }, /transfer/i],
    ['another chain', { chainId: 1 }, /Avalanche/],
    ['the Avalanche testnet', { chainId: 43113 }, /Avalanche/],
    ['a non-zero value', { value: '1' as '0' }, /AVAX|value/i],
  ])('refuses %s', (_name, change, about) => {
    expectRefused(() => avalancheDeposit.assertSafe(payload(change), plain), about)
  })

  it('refuses another chain’s payload', () => {
    expectRefused(
      () =>
        avalancheDeposit.assertSafe({ family: 'stellar', xdr: 'AAAA', account: ACCOUNT }, plain),
      /Avalanche/
    )
  })

  it('refuses an order naming a token other than USDC, which is all this deposit moves', () => {
    const usdt = { symbol: 'USDT', id: OTHER_TOKEN, decimals: 6 }
    expectRefused(() => avalancheDeposit.assertSafe(payload(), { ...plain, token: usdt }), /USDC/)
  })

  it('takes an order naming USDC as one naming nothing', () => {
    const usdc = { symbol: 'USDC', id: USDC.toLowerCase(), decimals: 6 }
    expect(() => avalancheDeposit.assertSafe(payload(), { ...plain, token: usdc })).not.toThrow()
  })

  it('refuses an order with a memo, which this chain cannot carry', () => {
    expectRefused(() => avalancheDeposit.assertSafe(payload(), { ...plain, memo: '42' }), /memo/i)
  })

  it('refuses an order that names the zero address, even if the calldata matches', () => {
    const data = `0xa9059cbb${addressWord(ZERO)}${word('bebc20')}`
    expectRefused(
      () => avalancheDeposit.assertSafe(payload({ data }), { ...plain, depositAddress: ZERO }),
      /deposit address/i
    )
  })
})

describe('avalancheDeposit.build', () => {
  it('builds the one transfer, when the account can pay it and its gas', async () => {
    const reads: string[] = []
    const deposit = createAvalancheDeposit(() =>
      fakeClient({
        usdcBalance: async (account) => {
          reads.push(`usdc ${account}`)
          return AMOUNT_UNITS
        },
        avaxBalance: async (account) => {
          reads.push(`avax ${account}`)
          return BigInt(1)
        },
      })
    )
    await expect(deposit.build(plain)).resolves.toEqual({
      family: 'evm',
      chainId: 43114,
      to: USDC,
      data: TRANSFER_DATA,
      value: '0',
    })
    expect(reads.sort()).toEqual([`avax ${ACCOUNT}`, `usdc ${ACCOUNT}`])
  })

  it('never builds USDC for an order that names another token', async () => {
    const deposit = createAvalancheDeposit(() => fakeClient())
    const usdt = { symbol: 'USDT', id: OTHER_TOKEN, decimals: 6 }
    await expect(deposit.build({ ...plain, token: usdt })).rejects.toThrow(/USDC/)
  })

  async function refusal(deposit: typeof avalancheDeposit, expectation = plain): Promise<Error> {
    return deposit.build(expectation).then(
      () => {
        throw new Error('expected a refusal')
      },
      (e: Error) => e
    )
  }

  it('refuses one unit short of the amount', async () => {
    const e = await refusal(
      createAvalancheDeposit(() =>
        fakeClient({ usdcBalance: async () => AMOUNT_UNITS - BigInt(1) })
      )
    )
    expect(e).toBeInstanceOf(ChainActionRefused)
    expect(e.message).toMatch(/USDC/)
    expect(e.message).toMatch(/Nothing was signed or sent\.$/)
  })

  it('refuses an account with no AVAX for gas', async () => {
    const e = await refusal(
      createAvalancheDeposit(() => fakeClient({ avaxBalance: async () => BigInt(0) }))
    )
    expect(e).toBeInstanceOf(ChainActionRefused)
    expect(e.message).toMatch(/AVAX/)
    expect(e.message).toMatch(/Nothing was signed or sent\.$/)
  })

  it('refuses when a balance cannot be read, rather than guessing', async () => {
    const e = await refusal(
      createAvalancheDeposit(() =>
        fakeClient({
          usdcBalance: async () => {
            throw new Error('rpc down')
          },
        })
      )
    )
    expect(e).toBeInstanceOf(ChainActionRefused)
    expect(e.message).not.toMatch(/rpc down/)
    expect(e.message).toMatch(/Nothing was signed or sent\.$/)
  })

  it.each<[string, Partial<DepositExpectation>, RegExp]>([
    ['a memo', { memo: '42' }, /memo/i],
    ['an account that is not one', { account: 'nope' }, /account/i],
    ['the zero address as account', { account: ZERO }, /account/i],
    ['the zero address as deposit', { depositAddress: ZERO }, /deposit address/i],
    ['the USDC contract as deposit', { depositAddress: USDC }, /deposit address/i],
    ['more places than USDC has', { amount: '1.0000001' }, /decimal/i],
    ['a zero amount', { amount: '0' }, /more than zero/i],
  ])('refuses %s before reading anything', async (_name, change, about) => {
    const read = vi.fn(async () => BigInt(0))
    const deposit = createAvalancheDeposit(() =>
      fakeClient({ usdcBalance: read, avaxBalance: read })
    )
    const e = await refusal(deposit, { ...plain, ...change })
    expect(e).toBeInstanceOf(ChainActionRefused)
    expect(e.message).toMatch(about)
    expect(read).not.toHaveBeenCalled()
  })
})

describe('avalancheDeposit.submit', () => {
  const signed = { family: 'evm' as const, hash: HASH }
  const withReceipt = (r: DepositReceipt | Error) =>
    createAvalancheDeposit(() =>
      fakeClient({
        waitForReceipt: async (hash) => {
          expect(hash).toBe(HASH)
          if (r instanceof Error) throw r
          return r
        },
      })
    )

  it('never confirms a USDC transfer for an order that names another token', async () => {
    const usdt = { symbol: 'USDT', id: OTHER_TOKEN, decimals: 6 }
    await expect(
      withReceipt(receipt()).submit(signed, { ...plain, token: usdt })
    ).rejects.toBeInstanceOf(ChainActionRefused)
  })

  it('confirms a transfer that paid this order', async () => {
    await expect(withReceipt(receipt()).submit(signed, plain)).resolves.toEqual({
      ok: true,
      hash: HASH,
      explorerUrl: `https://snowtrace.io/tx/${HASH}`,
    })
  })

  it('matches addresses without regard to casing', async () => {
    const r = receipt({ from: ACCOUNT, to: USDC.toLowerCase() as `0x${string}` })
    await expect(withReceipt(r).submit(signed, plain)).resolves.toMatchObject({ ok: true })
  })

  it('says only gas moved when the transfer reverted', async () => {
    const result = await withReceipt(receipt({ status: 'reverted', logs: [] })).submit(
      signed,
      plain
    )
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/did not move/i) })
    expect(result).not.toHaveProperty('pending')
  })

  it.each<[string, DepositReceipt]>([
    ['another sender', receipt({ from: OTHER as `0x${string}` })],
    ['a call to another contract', receipt({ to: OTHER_TOKEN as `0x${string}` })],
    ['a contract creation', receipt({ to: null })],
    ['no logs', receipt({ logs: [] })],
    ['a log from another token', receipt({ logs: [transferLog({ address: OTHER_TOKEN })] })],
    ['a transfer to someone else', receipt({ logs: [transferLog({ to: OTHER })] })],
    ['a transfer from someone else', receipt({ logs: [transferLog({ from: OTHER })] })],
    ['a transfer of another amount', receipt({ logs: [transferLog({ hexAmount: 'bebc21' })] })],
    ['a transfer of less', receipt({ logs: [transferLog({ hexAmount: 'bebc1f' })] })],
  ])('refuses a successful transaction with %s as not this deposit', async (_name, r) => {
    const result = await withReceipt(r).submit(signed, plain)
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/not this order/i) })
    expect(result).not.toHaveProperty('pending')
  })

  it.each([
    ['a timeout', new Error('Timed out while waiting for transaction')],
    ['a transaction that is not found', new Error('Transaction could not be found')],
  ])('treats %s as pending, naming the hash', async (_name, thrown) => {
    const result = await withReceipt(thrown).submit(signed, plain)
    expect(result).toMatchObject({ ok: false, pending: true })
    if (result.ok) throw new Error('expected pending')
    expect(result.error).toContain(HASH)
    expect(result.error).toMatch(/do not send/i)
  })

  it.each([
    ['too short', '0xabc'],
    ['without its prefix', 'a'.repeat(64)],
    ['with a character that is not hex', `0x${'g'.repeat(64)}`],
    ['with trailing text', `${HASH}zz`],
  ])('refuses a hash that is %s, without asking the chain', async (_name, hash) => {
    const wait = vi.fn(async () => receipt())
    const deposit = createAvalancheDeposit(() => fakeClient({ waitForReceipt: wait }))
    await expect(deposit.submit({ family: 'evm', hash }, plain)).rejects.toBeInstanceOf(
      ChainActionRefused
    )
    expect(wait).not.toHaveBeenCalled()
  })

  it('refuses another chain’s result, without asking the chain', async () => {
    const wait = vi.fn(async () => receipt())
    const deposit = createAvalancheDeposit(() => fakeClient({ waitForReceipt: wait }))
    await expect(
      deposit.submit({ family: 'stellar', signedXdr: 'AAAA' }, plain)
    ).rejects.toBeInstanceOf(ChainActionRefused)
    expect(wait).not.toHaveBeenCalled()
  })
})

describe('avalancheClient, over a local transport', () => {
  const blockHash = `0x${'b'.repeat(64)}`

  const rpcReceipt = {
    blockHash,
    blockNumber: '0x1',
    contractAddress: null,
    cumulativeGasUsed: '0x1',
    effectiveGasPrice: '0x1',
    from: ACCOUNT,
    gasUsed: '0x1',
    logs: [
      {
        address: USDC.toLowerCase(),
        blockHash,
        blockNumber: '0x1',
        data: `0x${word('bebc20')}`,
        logIndex: '0x0',
        removed: false,
        topics: [TRANSFER_TOPIC, `0x${addressWord(ACCOUNT)}`, `0x${addressWord(DEPOSIT)}`],
        transactionHash: HASH,
        transactionIndex: '0x0',
      },
    ],
    logsBloom: `0x${'0'.repeat(512)}`,
    status: '0x1',
    to: USDC.toLowerCase(),
    transactionHash: HASH,
    transactionIndex: '0x0',
    type: '0x2',
  }

  function transport(answers: Record<string, unknown>, seen: unknown[] = []) {
    return custom({
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        seen.push({ method, params })
        return answers[method] ?? null
      },
    })
  }

  it('reads USDC from the USDC contract and AVAX as the native balance', async () => {
    const seen: { method: string; params: unknown[] }[] = []
    const client = avalancheClient(
      transport(
        {
          eth_call: `0x${word('bebc20')}`,
          eth_getBalance: '0x5',
        },
        seen
      )
    )
    await expect(client.usdcBalance(ACCOUNT)).resolves.toBe(AMOUNT_UNITS)
    await expect(client.avaxBalance(ACCOUNT)).resolves.toBe(BigInt(5))
    const call = seen.find((s) => s.method === 'eth_call')?.params[0] as {
      to: string
      data: string
    }
    expect(call.to.toLowerCase()).toBe(USDC.toLowerCase())
    expect(call.data).toBe(`0x70a08231${addressWord(ACCOUNT)}`)
    const balance = seen.find((s) => s.method === 'eth_getBalance')?.params[0] as string
    expect(balance.toLowerCase()).toBe(ACCOUNT)
  })

  it('confirms a real receipt shape end to end', async () => {
    const deposit = createAvalancheDeposit(() =>
      avalancheClient(
        transport({
          eth_blockNumber: '0x2',
          eth_getTransactionReceipt: rpcReceipt,
        })
      )
    )
    await expect(deposit.submit({ family: 'evm', hash: HASH }, plain)).resolves.toMatchObject({
      ok: true,
      hash: HASH,
    })
  })

  it('gives up on a receipt that never comes at about 20 seconds, as pending', async () => {
    vi.useFakeTimers()
    const deposit = createAvalancheDeposit(() =>
      avalancheClient(transport({ eth_blockNumber: '0x2' }))
    )
    let settled: unknown
    const running = deposit.submit({ family: 'evm', hash: HASH }, plain).then((r) => {
      settled = r
      return r
    })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(running).resolves.toMatchObject({ ok: false, pending: true })
  })
})

describe('the EVM adapters’ signPrepared', () => {
  async function adapters() {
    return import('../adapters/evm-adapter')
  }

  it('exists on Avalanche and Monad, and not on Arc', async () => {
    const { arcAdapter, avalancheAdapter, monadAdapter } = await adapters()
    expect(avalancheAdapter.signPrepared).toBeTypeOf('function')
    expect(monadAdapter.signPrepared).toBeTypeOf('function')
    expect(arcAdapter.signPrepared).toBeUndefined()
    // The first import of the adapter pulls in the wallet libraries, which takes
    // longer than the default when the whole suite is running.
  }, 30_000)

  it('sends the transfer as prepared, when the wallet is already on Avalanche', async () => {
    const { avalancheAdapter } = await adapters()
    const out = await avalancheAdapter.signPrepared?.(payload())
    expect(out).toEqual({ ok: true, signed: { family: 'evm', hash: HASH_FROM_WALLET } })
    expect(wallet.calls).toEqual([
      ['send', { to: USDC, data: TRANSFER_DATA, value: BigInt(0), chainId: 43114 }],
    ])
  })

  it('switches first, when the wallet is elsewhere', async () => {
    wallet.account = { status: 'connected', chainId: 1 }
    const { avalancheAdapter } = await adapters()
    await avalancheAdapter.signPrepared?.(payload())
    expect(wallet.calls.map((c) => c[0])).toEqual(['switch', 'send'])
    expect(wallet.calls[0]?.[1]).toEqual({ chainId: 43114 })
  })

  it.each<[string, SigningPayload]>([
    ['another family', { family: 'stellar', xdr: 'AAAA', account: ACCOUNT }],
    ['another chain id', payload({ chainId: 1 })],
  ])('refuses %s without touching the wallet', async (_name, p) => {
    const { avalancheAdapter } = await adapters()
    const out = await avalancheAdapter.signPrepared?.(p)
    expect(out).toMatchObject({ ok: false, reason: 'wallet_error' })
    expect(out).toHaveProperty('detail', expect.stringMatching(/.+/))
    expect(wallet.calls).toEqual([])
  })

  it('asks for a reconnect when no wallet is connected', async () => {
    wallet.account = { status: 'disconnected', chainId: undefined }
    const { avalancheAdapter } = await adapters()
    const out = await avalancheAdapter.signPrepared?.(payload())
    expect(out).toMatchObject({ ok: false, reason: 'wallet_error' })
    expect(wallet.calls).toEqual([])
  })

  const declined = new TransactionExecutionError(
    new UserRejectedRequestError(new Error('nope')) as never,
    { account: { address: ACCOUNT }, docsPath: '', chain: undefined } as never
  )

  it.each<[string, unknown]>([
    ['viem’s rejection, however deep', declined],
    ['a wallet’s own wording', new Error('MetaMask Tx Signature: User denied transaction')],
    ['a closed popup', new Error('Popup closed')],
  ])('reads %s as a decline', async (_name, thrown) => {
    wallet.sendError = thrown
    const { avalancheAdapter } = await adapters()
    await expect(avalancheAdapter.signPrepared?.(payload())).resolves.toEqual({
      ok: false,
      reason: 'rejected',
    })
  })

  it('reads a declined network switch as a decline, and sends nothing', async () => {
    wallet.account = { status: 'connected', chainId: 1 }
    wallet.switchError = new Error('User rejected the request.')
    const { avalancheAdapter } = await adapters()
    await expect(avalancheAdapter.signPrepared?.(payload())).resolves.toEqual({
      ok: false,
      reason: 'rejected',
    })
    expect(wallet.calls.map((c) => c[0])).toEqual(['switch'])
  })

  it('keeps the detail of any other wallet failure', async () => {
    wallet.sendError = new Error('insufficient funds for gas')
    const { avalancheAdapter } = await adapters()
    await expect(avalancheAdapter.signPrepared?.(payload())).resolves.toEqual({
      ok: false,
      reason: 'wallet_error',
      detail: 'insufficient funds for gas',
    })
  })
})
