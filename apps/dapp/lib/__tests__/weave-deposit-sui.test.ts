import { Inputs, Transaction } from '@mysten/sui/transactions'
import { normalizeSuiAddress, toBase64 } from '@mysten/sui/utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SUI_TOKENS } from '../chains/sui/tokens'
import { ChainActionRefused } from '../chains/types'
import { suiDeposit } from '../weave/deposit/sui'
import type { DepositExpectation } from '../weave/types'

const core = vi.hoisted(() => ({
  listCoins: vi.fn(),
  getBalance: vi.fn(),
  getObjects: vi.fn(),
  executeTransaction: vi.fn(),
  resolveTransactionPlugin: vi.fn(),
}))

vi.mock('../chains/sui/client', async (original) => ({
  ...(await original<typeof import('../chains/sui/client')>()),
  suiClient: () => ({ core }),
}))

const ME = normalizeSuiAddress('0xa1')
const DEPOSIT = normalizeSuiAddress('0xd1')
const THIEF = normalizeSuiAddress('0xdead')
const USDC = SUI_TOKENS.find((t) => t.symbol === 'USDC')?.id as string
const USDSUI = SUI_TOKENS.find((t) => t.symbol === 'USDsui')?.id as string
const DIGEST = 'GKot5hBsd81kMupNCXHaqbhv3huEbxAFMLnpcX2hniwn'
const UNITS = BigInt(25_500_000)

const EXPECTATION: DepositExpectation = {
  account: ME,
  depositAddress: DEPOSIT,
  memo: undefined,
  amount: '25.5',
}

const COIN_A = normalizeSuiAddress('0xc1')
const COIN_B = normalizeSuiAddress('0xc2')
const GAS_COIN = normalizeSuiAddress('0xf1')

function coinRef(objectId: string) {
  return { objectId, version: '10', digest: DIGEST }
}

function base(fields: { sender?: string; gasOwner?: string } = {}): Transaction {
  const tx = new Transaction()
  tx.setSender(fields.sender ?? ME)
  tx.setGasOwner(fields.gasOwner ?? fields.sender ?? ME)
  tx.setGasPrice(1000)
  tx.setGasBudget(1_000_000)
  tx.setGasPayment([coinRef(GAS_COIN)])
  return tx
}

function owned(tx: Transaction, objectId: string) {
  return tx.object(Inputs.ObjectRef(coinRef(objectId)))
}

async function honest(fields: { sender?: string; gasOwner?: string } = {}): Promise<string> {
  const tx = base(fields)
  const coin = owned(tx, COIN_A)
  tx.mergeCoins(coin, [owned(tx, COIN_B)])
  const [split] = tx.splitCoins(coin, [UNITS])
  tx.transferObjects([split as never], DEPOSIT)
  return toBase64(await tx.build())
}

function check(transaction: string, expectation = EXPECTATION): void {
  suiDeposit.assertSafe({ family: 'sui', transaction }, expectation)
}

async function refused(transaction: string, reason: RegExp): Promise<void> {
  let caught: unknown
  try {
    check(transaction)
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(ChainActionRefused)
  expect((caught as Error).message).toMatch(reason)
  expect((caught as Error).message).toMatch(/nothing was signed or sent\.$/i)
}

async function edited(edit: (tx: Transaction) => void): Promise<string> {
  const tx = base()
  edit(tx)
  return toBase64(await tx.build())
}

function coinObject(objectId: string, type = USDC, owner = ME) {
  return {
    objectId,
    version: '10',
    digest: DIGEST,
    owner: { $kind: 'AddressOwner', AddressOwner: owner },
    type: `0x2::coin::Coin<${type}>`,
  }
}

function listed(balance: string, objectId: string, type = USDC) {
  return { ...coinObject(objectId, type), balance }
}

beforeEach(() => {
  for (const mock of Object.values(core)) mock.mockReset()
  core.resolveTransactionPlugin.mockReturnValue(
    async (
      data: { gasData: { price: unknown; budget: unknown; payment: unknown } },
      _options: unknown,
      next: () => Promise<void>
    ) => {
      data.gasData.price = '1000'
      data.gasData.budget = '1000000'
      data.gasData.payment = [coinRef(GAS_COIN)]
      await next()
    }
  )
  core.getObjects.mockImplementation(async ({ objectIds }: { objectIds: string[] }) => ({
    objects: objectIds.map((id) => coinObject(id)),
  }))
  core.executeTransaction.mockResolvedValue({
    Transaction: { digest: 'DIGESTx', effects: { status: { success: true } } },
  })
})

describe('what a deposit declares', () => {
  it('is USDC with six places and no memo', () => {
    expect(suiDeposit.chain).toBe('sui')
    expect(suiDeposit.usdcDecimals).toBe(6)
    expect(suiDeposit.supportsMemo).toBe(false)
  })

  it('takes full Sui addresses only', () => {
    expect(suiDeposit.isAccount(ME)).toBe(true)
    expect(suiDeposit.isDepositAddress(DEPOSIT)).toBe(true)
    expect(suiDeposit.isAccount('0xnope')).toBe(false)
    expect(suiDeposit.isDepositAddress('alice.sui')).toBe(false)
  })
})

describe('assertSafe admits the one shape', () => {
  it('merged coins, one split, one transfer', async () => {
    const transaction = await honest()
    expect(() => check(transaction)).not.toThrow()
  })

  it('one coin with no merge', async () => {
    const transaction = await edited((tx) => {
      const [split] = tx.splitCoins(owned(tx, COIN_A), [UNITS])
      tx.transferObjects([split as never], DEPOSIT)
    })
    expect(() => check(transaction)).not.toThrow()
  })

  it('a differently written form of the same addresses', async () => {
    const transaction = await honest()
    expect(() =>
      check(transaction, {
        ...EXPECTATION,
        account: ME.toUpperCase().replace('0X', '0x'),
        depositAddress: DEPOSIT.toUpperCase().replace('0X', '0x'),
      })
    ).not.toThrow()
  })
})

describe('assertSafe refuses', () => {
  it('a different recipient', async () => {
    const transaction = await edited((tx) => {
      const [split] = tx.splitCoins(owned(tx, COIN_A), [UNITS])
      tx.transferObjects([split as never], THIEF)
    })
    await refused(transaction, /deposit address/)
  })

  it('a different amount, one unit either way', async () => {
    for (const amount of [UNITS + BigInt(1), UNITS - BigInt(1)]) {
      const transaction = await edited((tx) => {
        const [split] = tx.splitCoins(owned(tx, COIN_A), [amount])
        tx.transferObjects([split as never], DEPOSIT)
      })
      await refused(transaction, /amount/)
    }
  })

  it('two amounts in the split', async () => {
    const transaction = await edited((tx) => {
      const [first, second] = tx.splitCoins(owned(tx, COIN_A), [UNITS, BigInt(1)])
      tx.transferObjects([first as never, second as never], DEPOSIT)
    })
    await refused(transaction, /amount/)
  })

  it('an extra transfer', async () => {
    const transaction = await edited((tx) => {
      const coin = owned(tx, COIN_A)
      const [split] = tx.splitCoins(coin, [UNITS])
      tx.transferObjects([split as never], DEPOSIT)
      const [skim] = tx.splitCoins(coin, [BigInt(1)])
      tx.transferObjects([skim as never], THIEF)
    })
    await refused(transaction, /one USDC transfer/)
  })

  it('a whole coin sent alongside the split', async () => {
    const transaction = await edited((tx) => {
      const [split] = tx.splitCoins(owned(tx, COIN_A), [UNITS])
      tx.transferObjects([split as never, owned(tx, COIN_B)], DEPOSIT)
    })
    await refused(transaction, /only the split/)
  })

  it('a whole coin sent instead of the split', async () => {
    const transaction = await edited((tx) => {
      const coin = owned(tx, COIN_A)
      tx.splitCoins(coin, [UNITS])
      tx.transferObjects([owned(tx, COIN_B)], DEPOSIT)
    })
    await refused(transaction, /only the split/)
  })

  it('a different sender', async () => {
    await refused(await honest({ sender: THIEF }), /sent from/)
  })

  it('a different gas owner', async () => {
    await refused(await honest({ gasOwner: THIEF }), /network fee/)
  })

  it('a MoveCall, even a harmless looking one', async () => {
    const transaction = await edited((tx) => {
      tx.moveCall({
        target: '0x2::transfer::public_transfer',
        typeArguments: [`0x2::coin::Coin<${USDC}>`],
        arguments: [owned(tx, COIN_B), tx.pure.address(THIEF)],
      })
      const [split] = tx.splitCoins(owned(tx, COIN_A), [UNITS])
      tx.transferObjects([split as never], DEPOSIT)
    })
    await refused(transaction, /one USDC transfer/)
  })

  it('splitting the gas coin', async () => {
    const transaction = await edited((tx) => {
      const [split] = tx.splitCoins(tx.gas, [UNITS])
      tx.transferObjects([split as never], DEPOSIT)
    })
    await refused(transaction, /gas coin/)
  })

  it('merging into the gas coin', async () => {
    const transaction = await edited((tx) => {
      const coin = owned(tx, COIN_A)
      tx.mergeCoins(tx.gas, [owned(tx, COIN_B)])
      const [split] = tx.splitCoins(coin, [UNITS])
      tx.transferObjects([split as never], DEPOSIT)
    })
    await refused(transaction, /gas coin/)
  })

  it('merging from the gas coin', async () => {
    const transaction = await edited((tx) => {
      const coin = owned(tx, COIN_A)
      tx.mergeCoins(coin, [tx.gas])
      const [split] = tx.splitCoins(coin, [UNITS])
      tx.transferObjects([split as never], DEPOSIT)
    })
    await refused(transaction, /gas coin/)
  })

  it('sending the gas coin itself', async () => {
    const transaction = await edited((tx) => {
      tx.splitCoins(owned(tx, COIN_A), [UNITS])
      tx.transferObjects([tx.gas], DEPOSIT)
    })
    await refused(transaction, /only the split/)
  })

  it('merging into a coin other than the one split', async () => {
    const transaction = await edited((tx) => {
      const coin = owned(tx, COIN_A)
      const other = owned(tx, COIN_B)
      tx.mergeCoins(other, [owned(tx, normalizeSuiAddress('0xc3'))])
      const [split] = tx.splitCoins(coin, [UNITS])
      tx.transferObjects([split as never], DEPOSIT)
    })
    await refused(transaction, /merges/)
  })

  it('the split sent twice', async () => {
    const transaction = await edited((tx) => {
      const coin = owned(tx, COIN_A)
      const [first] = tx.splitCoins(coin, [UNITS])
      tx.transferObjects([first as never], DEPOSIT)
      tx.transferObjects([first as never], DEPOSIT)
    })
    await refused(transaction, /one USDC transfer/)
  })

  it('a shared object as the coin', async () => {
    const transaction = await edited((tx) => {
      const shared = tx.object(
        Inputs.SharedObjectRef({
          objectId: COIN_A,
          initialSharedVersion: '1',
          mutable: true,
        })
      )
      const [split] = tx.splitCoins(shared, [UNITS])
      tx.transferObjects([split as never], DEPOSIT)
    })
    await refused(transaction, /owned coin/)
  })

  it('an input the commands never use', async () => {
    const transaction = await edited((tx) => {
      owned(tx, COIN_B)
      const [split] = tx.splitCoins(owned(tx, COIN_A), [UNITS])
      tx.transferObjects([split as never], DEPOSIT)
    })
    await refused(transaction, /inputs/)
  })

  it('address-balance funds drawn alongside, from anyone', async () => {
    const json = JSON.parse(await Transaction.from(await honest()).toJSON()) as {
      inputs: unknown[]
    }
    json.inputs.push({
      FundsWithdrawal: {
        reservation: { $kind: 'MaxAmountU64', MaxAmountU64: '1' },
        typeArg: { $kind: 'Balance', Balance: USDC },
        withdrawFrom: { $kind: 'Sender', Sender: true },
      },
    })
    const transaction = toBase64(await Transaction.from(JSON.stringify(json)).build())
    await refused(transaction, /address balance/)
  })

  it('bytes that are not a transaction', async () => {
    await refused('!!!', /could not read/)
    await refused(Buffer.from('hello').toString('base64'), /could not read/)
    await refused(
      Buffer.from(await Transaction.from(await honest()).toJSON()).toString('base64'),
      /could not read/
    )
  })

  it('a payload for another chain', async () => {
    const transaction = await honest()
    expect(() => suiDeposit.assertSafe({ family: 'solana', transaction }, EXPECTATION)).toThrow(
      ChainActionRefused
    )
  })

  it('an order with a memo', async () => {
    const transaction = await honest()
    expect(() => check(transaction, { ...EXPECTATION, memo: 'x' })).toThrow(/memo/)
  })

  it('an order whose deposit address is the account itself', async () => {
    const transaction = await honest()
    expect(() => check(transaction, { ...EXPECTATION, depositAddress: ME })).toThrow(
      ChainActionRefused
    )
  })
})

describe('build', () => {
  function coins(...objects: ReturnType<typeof listed>[]) {
    core.listCoins.mockResolvedValue({ objects, hasNextPage: false, cursor: null })
  }

  it('merges the USDC coins and pays exactly the amount', async () => {
    coins(listed('20000000', COIN_A), listed('10000000', COIN_B))
    const payload = await suiDeposit.build(EXPECTATION)
    expect(payload.family).toBe('sui')
    if (payload.family !== 'sui') return
    expect(() => suiDeposit.assertSafe(payload, EXPECTATION)).not.toThrow()

    const data = Transaction.from(payload.transaction).getData()
    expect(data.commands.map((c) => c.$kind)).toEqual([
      'MergeCoins',
      'SplitCoins',
      'TransferObjects',
    ])
    expect(core.listCoins).toHaveBeenCalledWith(
      expect.objectContaining({ owner: ME, coinType: USDC })
    )
    expect(data.sender).toBe(ME)
    expect(data.gasData.owner).toBe(ME)
  })

  it('stops reading coins once they cover the amount', async () => {
    core.listCoins.mockResolvedValueOnce({
      objects: [listed('30000000', COIN_A)],
      hasNextPage: true,
      cursor: 'next',
    })
    const payload = await suiDeposit.build(EXPECTATION)
    if (payload.family !== 'sui') throw new Error('wrong family')
    expect(core.listCoins).toHaveBeenCalledTimes(1)
    expect(
      Transaction.from(payload.transaction)
        .getData()
        .commands.map((c) => c.$kind)
    ).toEqual(['SplitCoins', 'TransferObjects'])
  })

  it('reads further pages when it needs them', async () => {
    core.listCoins
      .mockResolvedValueOnce({
        objects: [listed('20000000', COIN_A)],
        hasNextPage: true,
        cursor: 'next',
      })
      .mockResolvedValueOnce({
        objects: [listed('10000000', COIN_B)],
        hasNextPage: false,
        cursor: null,
      })
    await expect(suiDeposit.build(EXPECTATION)).resolves.toMatchObject({ family: 'sui' })
    expect(core.listCoins).toHaveBeenCalledTimes(2)
    expect(core.listCoins.mock.calls[1]?.[0]).toMatchObject({ cursor: 'next' })
  })

  it('never spends a coin of another type the network lists', async () => {
    coins(listed('90000000', COIN_B, USDSUI))
    core.getBalance.mockResolvedValue({
      balance: { coinType: USDC, balance: '0', coinBalance: '0', addressBalance: '0' },
    })
    await expect(suiDeposit.build(EXPECTATION)).rejects.toThrow(/less USDC/)
  })

  it('refuses a short balance', async () => {
    coins(listed('1000000', COIN_A))
    core.getBalance.mockResolvedValue({
      balance: {
        coinType: USDC,
        balance: '1000000',
        coinBalance: '1000000',
        addressBalance: '0',
      },
    })
    const attempt = suiDeposit.build(EXPECTATION)
    await expect(attempt).rejects.toBeInstanceOf(ChainActionRefused)
    await expect(attempt).rejects.toThrow(/less USDC.*nothing was signed or sent\.$/i)
  })

  it('refuses USDC held only in the address balance, naming why', async () => {
    coins()
    core.getBalance.mockResolvedValue({
      balance: {
        coinType: USDC,
        balance: '90000000',
        coinBalance: '0',
        addressBalance: '90000000',
      },
    })
    const attempt = suiDeposit.build(EXPECTATION)
    await expect(attempt).rejects.toBeInstanceOf(ChainActionRefused)
    await expect(attempt).rejects.toThrow(/address balance.*nothing was signed or sent\.$/i)
  })

  it('turns a failed build into a refusal the person can act on', async () => {
    coins(listed('90000000', COIN_A))
    core.resolveTransactionPlugin.mockReturnValue(async () => {
      throw new Error('Transaction resolution failed: MoveAbort')
    })
    const attempt = suiDeposit.build(EXPECTATION)
    await expect(attempt).rejects.toBeInstanceOf(ChainActionRefused)
    await expect(attempt).rejects.toThrow(/nothing was signed or sent\.$/i)
  })

  it.each([
    ['a memo', { memo: 'x' }],
    ['a bad account', { account: 'nope' }],
    ['a bad deposit address', { depositAddress: 'nope' }],
    ['the account as its own deposit', { depositAddress: ME }],
    ['too many places', { amount: '1.0000001' }],
    ['a zero amount', { amount: '0' }],
    ['an amount past what a coin can hold', { amount: '18446744073710' }],
  ])('refuses %s before asking the network', async (_name, change) => {
    const attempt = suiDeposit.build({ ...EXPECTATION, ...change })
    await expect(attempt).rejects.toBeInstanceOf(ChainActionRefused)
    await expect(attempt).rejects.toThrow(/nothing was signed or sent\.$/i)
    expect(core.listCoins).not.toHaveBeenCalled()
  })
})

describe('submit', () => {
  async function signedDeposit() {
    return { family: 'sui' as const, transaction: await honest(), signature: 'sig' }
  }

  it('sends a signed deposit made of the account’s USDC coins', async () => {
    const result = await suiDeposit.submit(await signedDeposit(), EXPECTATION)
    expect(result).toMatchObject({ ok: true, hash: 'DIGESTx' })
    expect(core.getObjects).toHaveBeenCalledWith(
      expect.objectContaining({ objectIds: [COIN_A, COIN_B] })
    )
    expect(core.executeTransaction).toHaveBeenCalledTimes(1)
  })

  it('says a failed deposit in cash-out words, not as a trade', async () => {
    core.executeTransaction.mockResolvedValue({
      FailedTransaction: { digest: 'DIGESTx', effects: { status: { success: false } } },
    })
    const result = await suiDeposit.submit(await signedDeposit(), EXPECTATION)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/your USDC did not move/i)
    expect(result.error).not.toMatch(/trade/i)
  })

  it('checks the signed bytes again and sends nothing if they changed', async () => {
    const swapped = await edited((tx) => {
      const [split] = tx.splitCoins(owned(tx, COIN_A), [UNITS])
      tx.transferObjects([split as never], THIEF)
    })
    await expect(
      suiDeposit.submit({ family: 'sui', transaction: swapped, signature: 'sig' }, EXPECTATION)
    ).rejects.toBeInstanceOf(ChainActionRefused)
    expect(core.executeTransaction).not.toHaveBeenCalled()
  })

  it('refuses a coin that is not USDC, which the bytes alone cannot show', async () => {
    core.getObjects.mockResolvedValue({
      objects: [coinObject(COIN_A), coinObject(COIN_B, USDSUI)],
    })
    await expect(suiDeposit.submit(await signedDeposit(), EXPECTATION)).rejects.toThrow(/USDC/)
    expect(core.executeTransaction).not.toHaveBeenCalled()
  })

  it('refuses a coin the account does not own', async () => {
    core.getObjects.mockResolvedValue({
      objects: [coinObject(COIN_A), coinObject(COIN_B, USDC, THIEF)],
    })
    await expect(suiDeposit.submit(await signedDeposit(), EXPECTATION)).rejects.toThrow(/USDC/)
    expect(core.executeTransaction).not.toHaveBeenCalled()
  })

  it('refuses when a coin cannot be read', async () => {
    core.getObjects.mockResolvedValue({ objects: [coinObject(COIN_A), new Error('not found')] })
    await expect(suiDeposit.submit(await signedDeposit(), EXPECTATION)).rejects.toBeInstanceOf(
      ChainActionRefused
    )
    expect(core.executeTransaction).not.toHaveBeenCalled()
  })

  it('refuses when the network names fewer coins than were asked about', async () => {
    core.getObjects.mockResolvedValue({ objects: [coinObject(COIN_A)] })
    await expect(suiDeposit.submit(await signedDeposit(), EXPECTATION)).rejects.toBeInstanceOf(
      ChainActionRefused
    )
    expect(core.executeTransaction).not.toHaveBeenCalled()
  })

  it('refuses when the coin read itself fails', async () => {
    core.getObjects.mockRejectedValue(new Error('down'))
    await expect(suiDeposit.submit(await signedDeposit(), EXPECTATION)).rejects.toBeInstanceOf(
      ChainActionRefused
    )
    expect(core.executeTransaction).not.toHaveBeenCalled()
  })

  it('refuses another family without sending', async () => {
    const result = await suiDeposit.submit({ family: 'near', hashes: ['x'] }, EXPECTATION)
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
    expect(core.executeTransaction).not.toHaveBeenCalled()
  })

  it('reports a send that broke mid-flight as pending, naming the digest', async () => {
    core.executeTransaction.mockRejectedValue(new Error('socket hang up'))
    const result = await suiDeposit.submit(await signedDeposit(), EXPECTATION)
    expect(result).toMatchObject({ ok: false, pending: true })
    if (!result.ok) expect(result.error).toMatch(/https:\/\/suiscan\.xyz\/mainnet\/tx\/\w+/)
  })

  it('reports a network rejection as a plain failure', async () => {
    core.executeTransaction.mockRejectedValue(
      Object.assign(new Error('nope'), { code: 'INVALID_ARGUMENT' })
    )
    const result = await suiDeposit.submit(await signedDeposit(), EXPECTATION)
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
  })
})
