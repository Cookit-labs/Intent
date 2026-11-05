import { stellarNetwork } from '@intent/config'
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Operation,
  StrKey,
  TransactionBuilder,
  type Transaction,
} from '@stellar/stellar-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChainActionRefused, type SigningPayload } from '../chains/types'
import { USDC } from '../swap/assets'
import { stellarDeposit } from '../weave/deposit/stellar'
import type { DepositExpectation } from '../weave/types'

const kit = vi.hoisted(() => ({
  signed: [] as { xdr: string; address: string | undefined }[],
  signError: undefined as Error | undefined,
  walletPassphrase: undefined as string | undefined,
}))

vi.mock('../stellar-kit', () => ({
  ensureKit: () => undefined,
  StellarWalletsKit: {
    getNetwork: async () => ({ network: 'x', networkPassphrase: kit.walletPassphrase }),
    signTransaction: async (xdr: string, opts?: { address?: string }) => {
      if (kit.signError !== undefined) throw kit.signError
      kit.signed.push({ xdr, address: opts?.address })
      return { signedTxXdr: `signed:${xdr}` }
    },
    setNetwork: () => undefined,
    selectedModule: { productIcon: '', productName: 'Test' },
  },
}))
vi.mock('../api/auth', () => ({
  clearSession: () => undefined,
  ensureSession: async () => undefined,
}))
vi.mock('@creit.tech/stellar-wallets-kit/types', () => ({
  Networks: { PUBLIC: 'PUBLIC', TESTNET: 'TESTNET' },
}))

const ACCOUNT = Keypair.random().publicKey()
const DEPOSIT = Keypair.random().publicKey()
const OTHER = Keypair.random().publicKey()
const APP_USDC = new Asset(USDC.code, USDC.issuer as string)

const plain: DepositExpectation = {
  account: ACCOUNT,
  depositAddress: DEPOSIT,
  memo: undefined,
  amount: '12.5',
}
const withMemo: DepositExpectation = { ...plain, memo: 'order-123' }

interface Shape {
  source?: string
  destination?: string
  amount?: string
  asset?: Asset
  memo?: Memo
  opSource?: string
  extra?: boolean
}

function tx(shape: Shape = {}): Transaction {
  const builder = new TransactionBuilder(new Account(shape.source ?? ACCOUNT, '100'), {
    fee: BASE_FEE,
    networkPassphrase: stellarNetwork.networkPassphrase,
  }).addOperation(
    Operation.payment({
      destination: shape.destination ?? DEPOSIT,
      asset: shape.asset ?? APP_USDC,
      amount: shape.amount ?? '12.5',
      ...(shape.opSource !== undefined ? { source: shape.opSource } : {}),
    })
  )
  if (shape.extra === true) {
    builder.addOperation(Operation.payment({ destination: OTHER, asset: APP_USDC, amount: '1' }))
  }
  if (shape.memo !== undefined) builder.addMemo(shape.memo)
  return builder.setTimeout(180).build()
}

function payload(shape: Shape = {}): SigningPayload {
  return { family: 'stellar', xdr: tx(shape).toXDR(), account: ACCOUNT }
}

function signedXdr(shape: Shape = {}): string {
  const t = tx(shape)
  t.sign(Keypair.random())
  return t.toXDR()
}

function feeBump(): string {
  const inner = tx()
  inner.sign(Keypair.random())
  const outer = TransactionBuilder.buildFeeBumpTransaction(
    Keypair.random(),
    '200',
    inner,
    stellarNetwork.networkPassphrase
  )
  return outer.toXDR()
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function stubFetch(answer: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fake = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    answer(String(url), init)
  )
  vi.stubGlobal('fetch', fake)
  return fake
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  kit.signed = []
  kit.signError = undefined
  kit.walletPassphrase = undefined
})

describe('stellarDeposit: what it says about itself', () => {
  it('carries seven decimals and memos', () => {
    expect(stellarDeposit.chain).toBe('stellar')
    expect(stellarDeposit.usdcDecimals).toBe(7)
    expect(stellarDeposit.supportsMemo).toBe(true)
  })

  it('takes only ordinary public keys as accounts and deposit addresses', () => {
    const muxed = StrKey.encodeMed25519PublicKey(Buffer.alloc(40, 1))
    const contract = StrKey.encodeContract(Buffer.alloc(32, 1))
    for (const check of [stellarDeposit.isAccount, stellarDeposit.isDepositAddress]) {
      expect(check(ACCOUNT)).toBe(true)
      expect(check(muxed)).toBe(false)
      expect(check(contract)).toBe(false)
      expect(check('')).toBe(false)
      expect(check('0x1111111111111111111111111111111111111111')).toBe(false)
    }
  })
})

describe('stellarDeposit.assertSafe', () => {
  it('admits exactly the payment the order asked for', () => {
    expect(() => stellarDeposit.assertSafe(payload(), plain)).not.toThrow()
  })

  it('reads 12.5 and 12.5000000 as one amount', () => {
    expect(() => stellarDeposit.assertSafe(payload({ amount: '12.5000000' }), plain)).not.toThrow()
  })

  it('admits an operation sourced from the account itself', () => {
    expect(() => stellarDeposit.assertSafe(payload({ opSource: ACCOUNT }), plain)).not.toThrow()
  })

  it('admits the exact memo the order needs', () => {
    expect(() =>
      stellarDeposit.assertSafe(payload({ memo: Memo.text('order-123') }), withMemo)
    ).not.toThrow()
  })

  it('compares a memo beyond ascii by its bytes', () => {
    const expectation = { ...plain, memo: 'héllo' }
    expect(() =>
      stellarDeposit.assertSafe(payload({ memo: Memo.text('héllo') }), expectation)
    ).not.toThrow()
    expectRefused(
      () => stellarDeposit.assertSafe(payload({ memo: Memo.text('hello') }), expectation),
      /memo/i
    )
  })

  it.each<[string, Shape, RegExp]>([
    ['another recipient', { destination: OTHER }, /deposit address/i],
    ['more than the order', { amount: '12.5000001' }, /amount/i],
    ['less than the order', { amount: '12.4999999' }, /amount/i],
    ['the same code from another issuer', { asset: new Asset(USDC.code, OTHER) }, /USDC/],
    [
      'another code from the same issuer',
      { asset: new Asset('USDT', USDC.issuer as string) },
      /USDC/,
    ],
    ['native XLM', { asset: Asset.native() }, /USDC/],
    ['another transaction source', { source: OTHER }, /account/i],
    ['an operation sourced elsewhere', { opSource: OTHER }, /account/i],
    ['a second operation', { extra: true }, /one payment/i],
  ])('refuses %s', (_name, shape, about) => {
    expectRefused(() => stellarDeposit.assertSafe(payload(shape), plain), about)
  })

  it('refuses a fee bump', () => {
    expectRefused(
      () =>
        stellarDeposit.assertSafe({ family: 'stellar', xdr: feeBump(), account: ACCOUNT }, plain),
      /fee bump/i
    )
  })

  it('refuses an operation that is not a payment', () => {
    const builder = new TransactionBuilder(new Account(ACCOUNT, '100'), {
      fee: BASE_FEE,
      networkPassphrase: stellarNetwork.networkPassphrase,
    })
      .addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: APP_USDC,
          sendAmount: '12.5',
          destination: DEPOSIT,
          destAsset: APP_USDC,
          destMin: '12.5',
        })
      )
      .setTimeout(180)
      .build()
    expectRefused(
      () =>
        stellarDeposit.assertSafe(
          { family: 'stellar', xdr: builder.toXDR(), account: ACCOUNT },
          plain
        ),
      /payment/i
    )
  })

  it('refuses a payload that names another account', () => {
    expectRefused(
      () =>
        stellarDeposit.assertSafe({ family: 'stellar', xdr: tx().toXDR(), account: OTHER }, plain),
      /account/i
    )
  })

  it('refuses another chain’s payload', () => {
    expectRefused(
      () => stellarDeposit.assertSafe({ family: 'solana', transaction: 'AAAA' }, plain),
      /Stellar/
    )
  })

  it('refuses bytes that are not a transaction', () => {
    expectRefused(
      () =>
        stellarDeposit.assertSafe({ family: 'stellar', xdr: 'not-xdr', account: ACCOUNT }, plain),
      /could not be read/i
    )
  })

  describe('the memo, which can lose funds if it is wrong', () => {
    it('refuses a missing memo when the order needs one', () => {
      expectRefused(() => stellarDeposit.assertSafe(payload(), withMemo), /memo/i)
    })

    it('refuses a different memo', () => {
      expectRefused(
        () => stellarDeposit.assertSafe(payload({ memo: Memo.text('order-124') }), withMemo),
        /memo/i
      )
    })

    it('refuses a memo the order does not have', () => {
      expectRefused(
        () => stellarDeposit.assertSafe(payload({ memo: Memo.text('order-123') }), plain),
        /memo/i
      )
    })

    it('refuses the right digits in an id memo when the order says text', () => {
      expectRefused(
        () =>
          stellarDeposit.assertSafe(payload({ memo: Memo.id('12345') }), {
            ...plain,
            memo: '12345',
          }),
        /memo/i
      )
    })

    it('refuses a hash memo', () => {
      expectRefused(
        () =>
          stellarDeposit.assertSafe(
            payload({ memo: Memo.hash(Buffer.alloc(32, 1).toString('hex')) }),
            withMemo
          ),
        /memo/i
      )
    })
  })
})

describe('stellarDeposit.build', () => {
  const horizon = (sequence = '4242') =>
    stubFetch((url) =>
      url.endsWith(`/accounts/${ACCOUNT}`) ? jsonResponse(200, { sequence }) : jsonResponse(500, {})
    )

  function read(built: SigningPayload): Transaction {
    if (built.family !== 'stellar') throw new Error(`built ${built.family}`)
    return TransactionBuilder.fromXDR(built.xdr, stellarNetwork.networkPassphrase) as Transaction
  }

  it('builds one USDC payment on the account’s next sequence, with no memo', async () => {
    const fake = horizon()
    const before = Math.floor(Date.now() / 1000)
    const built = await stellarDeposit.build(plain)
    expect(fake).toHaveBeenCalledWith(
      `${stellarNetwork.horizonUrl}/accounts/${ACCOUNT}`,
      expect.anything()
    )
    expect(built).toMatchObject({ family: 'stellar', account: ACCOUNT })
    const t = read(built)
    expect(t.source).toBe(ACCOUNT)
    expect(t.sequence).toBe('4243')
    expect(t.fee).toBe('100')
    expect(t.memo.type).toBe('none')
    expect(t.operations).toHaveLength(1)
    expect(t.operations[0]).toMatchObject({
      type: 'payment',
      destination: DEPOSIT,
      amount: '12.5000000',
    })
    const asset = (t.operations[0] as Operation.Payment).asset
    expect(asset.getCode()).toBe(USDC.code)
    expect(asset.getIssuer()).toBe(USDC.issuer)
    const maxTime = Number(t.timeBounds?.maxTime)
    expect(maxTime - before).toBeGreaterThanOrEqual(179)
    expect(maxTime - before).toBeLessThanOrEqual(182)
  })

  it('carries the order’s memo as text', async () => {
    horizon()
    const t = read(await stellarDeposit.build(withMemo))
    expect(t.memo.type).toBe('text')
    expect(Buffer.from(t.memo.value as Uint8Array).toString('utf8')).toBe('order-123')
  })

  it('takes a memo of exactly 28 bytes', async () => {
    horizon()
    const memo = 'x'.repeat(28)
    await expect(stellarDeposit.build({ ...plain, memo })).resolves.toMatchObject({
      family: 'stellar',
    })
  })

  it.each([
    ['29 bytes', 'x'.repeat(29)],
    ['30 bytes in 15 characters', 'é'.repeat(15)],
    ['nothing at all', ''],
  ])('refuses a memo of %s before asking the network', async (_name, memo) => {
    const fake = horizon()
    const e = await stellarDeposit.build({ ...plain, memo }).catch((err: Error) => err)
    expect(e).toBeInstanceOf(ChainActionRefused)
    expect((e as Error).message).toMatch(/memo/i)
    expect((e as Error).message).toMatch(/Nothing was signed or sent\.$/)
    expect(fake).not.toHaveBeenCalled()
  })

  it.each<[string, Partial<DepositExpectation>, RegExp]>([
    ['an account that is not one', { account: 'nope' }, /account/i],
    ['a deposit address that is not one', { depositAddress: 'nope' }, /deposit address/i],
    ['too many decimal places', { amount: '1.00000001' }, /decimal/i],
    ['a zero amount', { amount: '0' }, /more than zero/i],
    ['an amount that is not one', { amount: 'lots' }, /amount/i],
  ])('refuses %s', async (_name, change, about) => {
    const fake = horizon()
    const e = await stellarDeposit.build({ ...plain, ...change }).catch((err: Error) => err)
    expect(e).toBeInstanceOf(ChainActionRefused)
    expect((e as Error).message).toMatch(about)
    expect(fake).not.toHaveBeenCalled()
  })

  it('refuses an account that does not exist yet', async () => {
    stubFetch(() => jsonResponse(404, {}))
    const e = await stellarDeposit.build(plain).catch((err: Error) => err)
    expect(e).toBeInstanceOf(ChainActionRefused)
    expect((e as Error).message).toMatch(/not funded/i)
    expect((e as Error).message).toMatch(/Nothing was signed or sent\.$/)
  })

  it('refuses when the network cannot be read', async () => {
    stubFetch(() => {
      throw new Error('socket hang up')
    })
    const e = await stellarDeposit.build(plain).catch((err: Error) => err)
    expect(e).toBeInstanceOf(ChainActionRefused)
    expect((e as Error).message).toMatch(/Nothing was signed or sent\.$/)
  })
})

describe('stellarDeposit.submit', () => {
  it('sends the signed bytes unchanged and reports the hash', async () => {
    const xdr = signedXdr()
    const hash = Buffer.from(
      TransactionBuilder.fromXDR(xdr, stellarNetwork.networkPassphrase).hash()
    ).toString('hex')
    const posted: string[] = []
    stubFetch((url, init) => {
      posted.push(`${url} ${String(init?.body)}`)
      return jsonResponse(200, { hash, ledger: 7, successful: true })
    })
    const result = await stellarDeposit.submit({ family: 'stellar', signedXdr: xdr }, plain)
    expect(result).toEqual({
      ok: true,
      hash,
      explorerUrl: `${stellarNetwork.blockExplorerUrl}/tx/${hash}`,
    })
    expect(posted).toEqual([
      `${stellarNetwork.horizonUrl}/transactions ${new URLSearchParams({ tx: xdr }).toString()}`,
    ])
  })

  it('refuses another chain’s result and sends nothing', async () => {
    const fake = stubFetch(() => jsonResponse(500, {}))
    await expect(
      stellarDeposit.submit({ family: 'evm', hash: `0x${'a'.repeat(64)}` }, plain)
    ).rejects.toBeInstanceOf(ChainActionRefused)
    expect(fake).not.toHaveBeenCalled()
  })

  it.each<[string, Shape, DepositExpectation]>([
    ['a swapped recipient', { destination: OTHER }, plain],
    ['a dropped memo', {}, withMemo],
    ['an added memo', { memo: Memo.text('order-123') }, plain],
  ])('refuses signed bytes with %s and sends nothing', async (_name, shape, expectation) => {
    const fake = stubFetch(() => jsonResponse(200, { hash: 'x', successful: true }))
    const e = await stellarDeposit
      .submit({ family: 'stellar', signedXdr: signedXdr(shape) }, expectation)
      .catch((err: Error) => err)
    expect(e).toBeInstanceOf(ChainActionRefused)
    // The wallet has signed by now, so the sentence must not say otherwise.
    expect((e as Error).message).not.toMatch(/Nothing was signed/)
    expect((e as Error).message).toMatch(/not sent/i)
    expect(fake).not.toHaveBeenCalled()
  })

  it('reports a definite refusal from the network as a plain failure', async () => {
    stubFetch(() =>
      jsonResponse(400, {
        extras: { result_codes: { transaction: 'tx_failed', operations: ['op_underfunded'] } },
      })
    )
    const result = await stellarDeposit.submit({ family: 'stellar', signedXdr: signedXdr() }, plain)
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
  })

  it('reports a failure inside a ledger as a plain failure', async () => {
    stubFetch(() =>
      jsonResponse(200, {
        hash: 'abc',
        successful: false,
        extras: { result_codes: { transaction: 'tx_failed', operations: ['op_no_trust'] } },
      })
    )
    const result = await stellarDeposit.submit({ family: 'stellar', signedXdr: signedXdr() }, plain)
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
  })

  it('treats a used-up sequence as pending, because an earlier send may have landed', async () => {
    stubFetch(() => jsonResponse(400, { extras: { result_codes: { transaction: 'tx_bad_seq' } } }))
    const result = await stellarDeposit.submit({ family: 'stellar', signedXdr: signedXdr() }, plain)
    expect(result).toMatchObject({ ok: false, pending: true })
  })

  it('treats no verdict from the network as pending, naming the hash', async () => {
    vi.useFakeTimers()
    const xdr = signedXdr()
    const hash = Buffer.from(
      TransactionBuilder.fromXDR(xdr, stellarNetwork.networkPassphrase).hash()
    ).toString('hex')
    stubFetch(() => {
      throw new Error('socket hang up')
    })
    const running = stellarDeposit.submit({ family: 'stellar', signedXdr: xdr }, plain)
    await vi.advanceTimersByTimeAsync(30_000)
    const result = await running
    expect(result).toMatchObject({ ok: false, pending: true })
    if (result.ok) throw new Error('expected pending')
    expect(result.error).toContain(hash)
    expect(result.error).toMatch(/do not send/i)
  })

  it('counts a transfer that landed after Horizon timed out as done', async () => {
    const xdr = signedXdr()
    const hash = Buffer.from(
      TransactionBuilder.fromXDR(xdr, stellarNetwork.networkPassphrase).hash()
    ).toString('hex')
    stubFetch((url) =>
      url.endsWith(`/transactions/${hash}`)
        ? jsonResponse(200, { hash, ledger: 9, successful: true })
        : jsonResponse(504, {})
    )
    const result = await stellarDeposit.submit({ family: 'stellar', signedXdr: xdr }, plain)
    expect(result).toMatchObject({ ok: true, hash })
  })
})

describe('the Stellar adapter’s signPrepared', () => {
  const PASSPHRASE = stellarNetwork.networkPassphrase
  const WRONG =
    PASSPHRASE === 'Test SDF Network ; September 2015'
      ? 'Public Global Stellar Network ; September 2015'
      : 'Test SDF Network ; September 2015'

  async function adapter() {
    const mod = await import('../adapters/stellar-adapter')
    return mod.stellarAdapter
  }

  it('signs the payload for the account it names', async () => {
    const a = await adapter()
    kit.walletPassphrase = PASSPHRASE
    const out = await a.signPrepared?.({ family: 'stellar', xdr: 'AAAA', account: ACCOUNT })
    expect(out).toEqual({ ok: true, signed: { family: 'stellar', signedXdr: 'signed:AAAA' } })
    expect(kit.signed).toEqual([{ xdr: 'AAAA', address: ACCOUNT }])
  })

  it('reports a decline as rejected', async () => {
    const a = await adapter()
    kit.walletPassphrase = PASSPHRASE
    kit.signError = new Error('User declined the request')
    await expect(
      a.signPrepared?.({ family: 'stellar', xdr: 'AAAA', account: ACCOUNT })
    ).resolves.toEqual({ ok: false, reason: 'rejected' })
  })

  it('keeps the detail when the wallet is on the wrong network', async () => {
    const a = await adapter()
    kit.walletPassphrase = WRONG
    const out = await a.signPrepared?.({ family: 'stellar', xdr: 'AAAA', account: ACCOUNT })
    expect(out).toMatchObject({ ok: false, reason: 'wallet_error' })
    expect(out).toHaveProperty('detail', expect.stringMatching(/.+/))
    expect(kit.signed).toEqual([])
  })

  it('keeps the detail of any other wallet failure', async () => {
    const a = await adapter()
    kit.walletPassphrase = PASSPHRASE
    kit.signError = new Error('The extension crashed')
    await expect(
      a.signPrepared?.({ family: 'stellar', xdr: 'AAAA', account: ACCOUNT })
    ).resolves.toEqual({ ok: false, reason: 'wallet_error', detail: 'The extension crashed' })
  })

  it('refuses another family without calling the wallet', async () => {
    const a = await adapter()
    const out = await a.signPrepared?.({ family: 'solana', transaction: 'AAAA' })
    expect(out).toMatchObject({ ok: false, reason: 'wallet_error' })
    expect(kit.signed).toEqual([])
  })
})
