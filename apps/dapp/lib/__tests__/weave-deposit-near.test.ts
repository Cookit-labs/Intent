import { beforeEach, describe, expect, it, vi } from 'vitest'

import { isRegistered, waitForTransaction, type ExecutedCall } from '../chains/near/rpc'
import { STORAGE_DEPOSIT_YOCTO, STORAGE_GAS, TRANSFER_GAS } from '../chains/near/safety'
import { USDC_NEAR, USDT_NEAR, WRAP_NEAR } from '../chains/near/tokens'
import { ChainActionRefused, type NearTransaction, type SigningPayload } from '../chains/types'
import { nearDeposit } from '../weave/deposit/near'
import type { DepositExpectation } from '../weave/types'

vi.mock('../chains/near/rpc', async (original) => ({
  ...(await original<typeof import('../chains/near/rpc')>()),
  isRegistered: vi.fn(),
  waitForTransaction: vi.fn(),
}))

const ACCOUNT = 'alice.near'
const DEPOSIT = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const HASH = '4'.repeat(44)
const UNITS = '25500000'

const EXPECTATION: DepositExpectation = {
  account: ACCOUNT,
  depositAddress: DEPOSIT,
  memo: undefined,
  amount: '25.5',
}

type Action = NearTransaction['actions'][number]

function ftTransfer(args: Record<string, unknown> = {}): Action {
  return {
    type: 'FunctionCall',
    params: {
      methodName: 'ft_transfer',
      args: { receiver_id: DEPOSIT, amount: UNITS, ...args },
      gas: TRANSFER_GAS.toString(),
      deposit: '1',
    },
  }
}

function storageFor(account: string): Action {
  return {
    type: 'FunctionCall',
    params: {
      methodName: 'storage_deposit',
      args: { account_id: account, registration_only: true },
      gas: STORAGE_GAS.toString(),
      deposit: STORAGE_DEPOSIT_YOCTO,
    },
  }
}

function payload(actions: Action[], receiverId = USDC_NEAR): SigningPayload {
  return { family: 'near', transactions: [{ receiverId, actions }] }
}

function refused(candidate: SigningPayload, reason: RegExp, expectation = EXPECTATION): void {
  let caught: unknown
  try {
    nearDeposit.assertSafe(candidate, expectation)
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(ChainActionRefused)
  expect((caught as Error).message).toMatch(reason)
  expect((caught as Error).message).toMatch(/nothing was signed or sent\.$/i)
}

function landed(
  fields: { signer?: string; receiver?: string; calls?: ExecutedCall[]; failed?: boolean } = {}
): void {
  vi.mocked(waitForTransaction).mockResolvedValue({
    state: fields.failed === true ? 'failed' : 'success',
    signer: fields.signer ?? ACCOUNT,
    receiver: fields.receiver ?? USDC_NEAR,
    calls: fields.calls ?? [
      { method: 'ft_transfer', args: { receiver_id: DEPOSIT, amount: UNITS }, deposit: '1' },
    ],
  })
}

beforeEach(() => {
  vi.mocked(isRegistered).mockReset()
  vi.mocked(waitForTransaction).mockReset()
})

describe('what a deposit declares', () => {
  it('is USDC with six places and no memo', () => {
    expect(nearDeposit.chain).toBe('near')
    expect(nearDeposit.usdcDecimals).toBe(6)
    expect(nearDeposit.supportsMemo).toBe(false)
  })

  it('takes a NEAR account and a 64-hex deposit address', () => {
    expect(nearDeposit.isAccount(ACCOUNT)).toBe(true)
    expect(nearDeposit.isAccount('NOT VALID')).toBe(false)
    expect(nearDeposit.isDepositAddress(DEPOSIT)).toBe(true)
    expect(nearDeposit.isDepositAddress('deposit.near')).toBe(false)
    expect(nearDeposit.isDepositAddress('A'.repeat(64))).toBe(false)
  })
})

describe('assertSafe admits the one shape', () => {
  it('a transfer alone', () => {
    expect(() => nearDeposit.assertSafe(payload([ftTransfer()]), EXPECTATION)).not.toThrow()
  })

  it('storage for the deposit address, then the transfer', () => {
    expect(() =>
      nearDeposit.assertSafe(payload([storageFor(DEPOSIT), ftTransfer()]), EXPECTATION)
    ).not.toThrow()
  })
})

describe('assertSafe refuses', () => {
  it('a different recipient, which the shape check alone would admit', () => {
    refused(payload([ftTransfer({ receiver_id: OTHER })]), /deposit address/)
  })

  it('a named account as the recipient', () => {
    refused(payload([ftTransfer({ receiver_id: 'bob.near' })]), /deposit address/)
  })

  it('a different amount, one unit either way, or written differently', () => {
    refused(payload([ftTransfer({ amount: '25500001' })]), /amount/)
    refused(payload([ftTransfer({ amount: '25499999' })]), /amount/)
    refused(payload([ftTransfer({ amount: '025500000' })]), /amount/)
  })

  it('a different token', () => {
    refused(payload([ftTransfer()], USDT_NEAR), /USDC/)
    refused(payload([ftTransfer()], 'usdc.fake.near'), /not a token/)
  })

  it('wrapped NEAR, which is a shape the shared check would otherwise allow', () => {
    const wrap: Action = {
      type: 'FunctionCall',
      params: { methodName: 'near_deposit', args: {}, gas: '1000', deposit: UNITS },
    }
    refused(payload([wrap, ftTransfer()], WRAP_NEAR), /USDC/)
  })

  it('an extra transfer', () => {
    refused(payload([ftTransfer({ receiver_id: OTHER }), ftTransfer()]), /not allowed/)
    refused(payload([ftTransfer(), ftTransfer()]), /not allowed/)
  })

  it('a second transaction', () => {
    refused(
      {
        family: 'near',
        transactions: [
          { receiverId: USDC_NEAR, actions: [ftTransfer()] },
          { receiverId: USDC_NEAR, actions: [ftTransfer()] },
        ],
      },
      /exactly one/
    )
  })

  it('ft_transfer_call, which runs code on the receiver', () => {
    const call = ftTransfer()
    refused(
      payload([{ ...call, params: { ...call.params, methodName: 'ft_transfer_call' } }]),
      /end in a token transfer/
    )
  })

  it('an unknown method before the transfer', () => {
    const call = ftTransfer()
    refused(
      payload([{ ...call, params: { ...call.params, methodName: 'set_owner' } }, ftTransfer()]),
      /not allowed/
    )
  })

  it('an extra argument on the transfer', () => {
    refused(payload([ftTransfer({ memo: 'x' })]), /unexpected arguments/)
  })

  it('storage paid for anyone but the deposit address', () => {
    refused(payload([storageFor(OTHER), ftTransfer()]), /unexpected account/)
    refused(payload([storageFor(ACCOUNT), ftTransfer()]), /unexpected account/)
  })

  it('an order with a memo', () => {
    refused(payload([ftTransfer()]), /memo/, { ...EXPECTATION, memo: 'x' })
  })

  it('an order with no valid signer account', () => {
    refused(payload([ftTransfer()]), /not a NEAR account/, { ...EXPECTATION, account: 'NOPE!' })
  })

  it('an order whose amount has too many places', () => {
    refused(payload([ftTransfer()]), /decimal/, { ...EXPECTATION, amount: '25.5000001' })
  })

  it('a payload for another chain', () => {
    refused({ family: 'solana', transaction: 'AA==' }, /not a NEAR transaction/)
  })
})

describe('build', () => {
  it('adds storage for an unregistered deposit address, then the transfer', async () => {
    vi.mocked(isRegistered).mockResolvedValue(false)
    const built = await nearDeposit.build(EXPECTATION)
    expect(built).toEqual(payload([storageFor(DEPOSIT), ftTransfer()]))
    expect(isRegistered).toHaveBeenCalledWith(USDC_NEAR, DEPOSIT)
  })

  it('leaves storage out for a registered one', async () => {
    vi.mocked(isRegistered).mockResolvedValue(true)
    expect(await nearDeposit.build(EXPECTATION)).toEqual(payload([ftTransfer()]))
  })

  it('refuses when the network cannot say whether it is registered', async () => {
    vi.mocked(isRegistered).mockRejectedValue(new Error('down'))
    await expect(nearDeposit.build(EXPECTATION)).rejects.toBeInstanceOf(ChainActionRefused)
  })

  it.each([
    ['a memo', { memo: 'x' }],
    ['a bad account', { account: 'NOPE!' }],
    ['a named deposit address', { depositAddress: 'bob.near' }],
    ['the account as its own deposit', { account: DEPOSIT }],
    ['too many places', { amount: '1.0000001' }],
    ['a zero amount', { amount: '0' }],
  ])('refuses %s before asking the network', async (_name, change) => {
    const attempt = nearDeposit.build({ ...EXPECTATION, ...change })
    await expect(attempt).rejects.toBeInstanceOf(ChainActionRefused)
    await expect(attempt).rejects.toThrow(/nothing was signed or sent\.$/i)
    expect(isRegistered).not.toHaveBeenCalled()
  })
})

describe('submit', () => {
  const signed = { family: 'near' as const, hashes: [HASH] }

  it('confirms the deposit on chain', async () => {
    landed()
    const result = await nearDeposit.submit(signed, EXPECTATION)
    expect(result).toEqual({
      ok: true,
      hash: HASH,
      explorerUrl: `https://nearblocks.io/txns/${HASH}`,
    })
    expect(waitForTransaction).toHaveBeenCalledWith(HASH, ACCOUNT, 15_000)
  })

  it('follows the last hash the wallet returned', async () => {
    landed()
    const last = '5'.repeat(44)
    await nearDeposit.submit({ family: 'near', hashes: [HASH, last] }, EXPECTATION)
    expect(waitForTransaction).toHaveBeenCalledWith(last, ACCOUNT, 15_000)
  })

  it('confirms a transfer that followed a storage payment', async () => {
    landed({
      calls: [
        {
          method: 'storage_deposit',
          args: { account_id: DEPOSIT, registration_only: true },
          deposit: STORAGE_DEPOSIT_YOCTO,
        },
        { method: 'ft_transfer', args: { receiver_id: DEPOSIT, amount: UNITS }, deposit: '1' },
      ],
    })
    expect((await nearDeposit.submit(signed, EXPECTATION)).ok).toBe(true)
  })

  it.each([
    ['another signer', { signer: 'mallory.near' }],
    ['another token', { receiver: USDT_NEAR }],
    [
      'another recipient',
      {
        calls: [
          { method: 'ft_transfer', args: { receiver_id: OTHER, amount: UNITS }, deposit: '1' },
        ],
      },
    ],
    [
      'another amount',
      {
        calls: [
          { method: 'ft_transfer', args: { receiver_id: DEPOSIT, amount: '1' }, deposit: '1' },
        ],
      },
    ],
    [
      'no amount at all',
      { calls: [{ method: 'ft_transfer', args: { receiver_id: DEPOSIT }, deposit: '1' }] },
    ],
    [
      'another method',
      {
        calls: [
          {
            method: 'ft_transfer_call',
            args: { receiver_id: DEPOSIT, amount: UNITS },
            deposit: '1',
          },
        ],
      },
    ],
    ['no calls', { calls: [] }],
  ])('says %s is not this order’s deposit', async (_name, fields) => {
    landed(fields)
    const result = await nearDeposit.submit(signed, EXPECTATION)
    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty('pending')
    if (!result.ok) expect(result.error).toMatch(/not this order/)
  })

  it('reports a failed transaction plainly', async () => {
    landed({ failed: true })
    const result = await nearDeposit.submit(signed, EXPECTATION)
    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty('pending')
    if (!result.ok) expect(result.error).toMatch(/did not leave.*gas/)
  })

  it('reports an unseen transaction as pending, with the hash', async () => {
    vi.mocked(waitForTransaction).mockResolvedValue({ state: 'unknown' })
    const result = await nearDeposit.submit(signed, EXPECTATION)
    expect(result).toMatchObject({ ok: false, pending: true })
    if (!result.ok) {
      expect(result.error).toContain(HASH)
      expect(result.error).toMatch(/don.t send it again/i)
    }
  })

  it('treats a missing or malformed hash as may-have-landed, since the wallet sends for itself', async () => {
    for (const hashes of [[], ['not-a-hash']]) {
      const result = await nearDeposit.submit({ family: 'near', hashes }, EXPECTATION)
      expect(result).toMatchObject({ ok: false, pending: true })
    }
    expect(waitForTransaction).not.toHaveBeenCalled()
  })

  it('refuses another family without looking anything up', async () => {
    const result = await nearDeposit.submit(
      { family: 'solana', signedTransaction: 'AA==' },
      EXPECTATION
    )
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
    expect(waitForTransaction).not.toHaveBeenCalled()
  })
})
