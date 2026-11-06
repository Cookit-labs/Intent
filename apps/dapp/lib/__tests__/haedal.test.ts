import { bcs } from '@mysten/sui/bcs'
import { Inputs, Transaction } from '@mysten/sui/transactions'
import { toBase64 } from '@mysten/sui/utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assertPinnedObjects,
  creditedAmount,
  HAEDAL_PACKAGE,
  HAEDAL_STAKING,
  HAEDAL_TOKENS,
  haedalVenue,
  HASUI_TYPE,
  percentText,
  returnedCoinAmount,
} from '../chains/sui/haedal'
import { ChainActionRefused } from '../chains/types'

const ME = '0x1111111111111111111111111111111111111111111111111111111111111111'
const THIEF = '0x000000000000000000000000000000000000000000000000000000000000dead'
const FOREIGN = '0x00000000000000000000000000000000000000000000000000000000000bad01'
const DIGEST = '11111111111111111111111111111111'

const mocks = vi.hoisted(() => ({
  simulate: vi.fn(),
  getObjects: vi.fn(),
  built: [] as Transaction[],
  bytes: '',
}))

vi.mock('../chains/sui/client', async (original) => ({
  ...(await original<typeof import('../chains/sui/client')>()),
  suiClient: () => ({
    core: { simulateTransaction: mocks.simulate, getObjects: mocks.getObjects },
  }),
  buildUnsigned: async (tx: Transaction) => {
    mocks.built.push(tx)
    return mocks.bytes
  },
}))

function shared(tx: Transaction, objectId: string) {
  return tx.object(Inputs.SharedObjectRef({ objectId, initialSharedVersion: 1, mutable: true }))
}

function ownedCoin(tx: Transaction, objectId = FOREIGN) {
  return tx.object(Inputs.ObjectRef({ objectId, version: 1, digest: DIGEST }))
}

async function built(
  edit: (tx: Transaction) => void,
  sender: string = ME,
  gasOwner: string = sender
): Promise<string> {
  const tx = new Transaction()
  tx.setSender(sender)
  tx.setGasOwner(gasOwner)
  tx.setGasPrice(1000)
  tx.setGasBudget(10_000_000)
  tx.setGasPayment([{ objectId: FOREIGN, version: 1, digest: DIGEST }])
  edit(tx)
  return toBase64(await tx.build())
}

const STAKE = `${HAEDAL_PACKAGE}::staking::request_stake_coin`
const UNSTAKE = `${HAEDAL_PACKAGE}::staking::request_unstake_instant_coin`

function goodStake(tx: Transaction, validator = '0x0', staking = HAEDAL_STAKING, to = ME): void {
  const [sui] = tx.splitCoins(tx.gas, [BigInt(1_000_000_000)])
  const [minted] = tx.moveCall({
    target: STAKE,
    arguments: [shared(tx, '0x5'), shared(tx, staking), sui as never, tx.pure.address(validator)],
  })
  tx.transferObjects([minted as never], to)
}

function goodUnstake(tx: Transaction, to = ME): void {
  const [sui] = tx.moveCall({
    target: UNSTAKE,
    arguments: [shared(tx, '0x5'), shared(tx, HAEDAL_STAKING), ownedCoin(tx, THIEF)],
  })
  tx.transferObjects([sui as never], to)
}

function check(transaction: string, account: string = ME): void {
  haedalVenue.assertSafe({ family: 'sui', transaction }, account)
}

beforeEach(() => {
  mocks.simulate.mockReset()
  mocks.getObjects.mockReset()
  mocks.built.length = 0
  mocks.getObjects.mockResolvedValue({
    objects: [{ json: { config: { service_fee: '2000', reward_fee: '600000' } } }],
  })
})

describe('Haedal safety on what the wallet would sign', () => {
  it('passes the stake and the unstake it builds', async () => {
    await expect(built(goodStake).then(check)).resolves.toBeUndefined()
    await expect(built(goodUnstake).then(check)).resolves.toBeUndefined()
  })

  it('refuses the wrong account', async () => {
    const transaction = await built(goodStake)
    expect(() => check(transaction, THIEF)).toThrow(/different account/)
  })

  it('refuses gas paid by someone else', async () => {
    const transaction = await built(goodStake, ME, THIEF)
    expect(() => check(transaction)).toThrow(/network fee/)
  })

  it('refuses an unknown contract', async () => {
    const transaction = await built((tx) => {
      goodStake(tx)
      tx.moveCall({ target: `${FOREIGN}::drain::everything` })
    })
    expect(() => check(transaction)).toThrow(/confirmed/)
  })

  it.each([
    'request_unstake_delay',
    'request_unstake_instant_v2',
    'claim_coin_v2',
    'get_exchange_rate',
  ])('refuses %s, which this flow never uses', async (fn) => {
    const transaction = await built((tx) => {
      tx.moveCall({ target: `${HAEDAL_PACKAGE}::staking::${fn}` })
    })
    expect(() => check(transaction)).toThrow(/confirmed/)
  })

  it('refuses anything in the vault and manage modules', async () => {
    for (const target of ['vault::deposit', 'manage::collect_service_fee']) {
      const transaction = await built((tx) => {
        tx.moveCall({ target: `${HAEDAL_PACKAGE}::${target}` })
      })
      expect(() => check(transaction)).toThrow(/confirmed/)
    }
  })

  it('refuses extra steps', async () => {
    const transaction = await built((tx) => {
      goodStake(tx)
      tx.publish({ modules: ['AA=='], dependencies: ['0x1', '0x2'] })
    })
    expect(() => check(transaction)).toThrow(/Publish/)
  })

  it('refuses the framework transfer, which would hide a payment', async () => {
    const transaction = await built((tx) => {
      goodStake(tx)
      const [coin] = tx.splitCoins(tx.gas, [BigInt(1)])
      tx.moveCall({
        target: '0x2::transfer::public_transfer',
        typeArguments: ['0x2::coin::Coin<0x2::sui::SUI>'],
        arguments: [coin as never, tx.pure.address(THIEF)],
      })
    })
    expect(() => check(transaction)).toThrow(/confirmed/)
  })

  it('refuses haSUI paid to someone else', async () => {
    const transaction = await built((tx) => goodStake(tx, '0x0', HAEDAL_STAKING, THIEF))
    expect(() => check(transaction)).toThrow(/another address/)
  })

  it('refuses SUI from an unstake paid to someone else', async () => {
    const transaction = await built((tx) => goodUnstake(tx, THIEF))
    expect(() => check(transaction)).toThrow(/another address/)
  })

  it('refuses a stake object other than Haedal’s', async () => {
    const transaction = await built((tx) => goodStake(tx, '0x0', FOREIGN))
    expect(() => check(transaction)).toThrow(/object/)
  })

  it('refuses a validator it did not choose', async () => {
    const transaction = await built((tx) => goodStake(tx, THIEF))
    expect(() => check(transaction)).toThrow(/validator/)
  })

  it('refuses a call that names a token', async () => {
    const transaction = await built((tx) => {
      tx.moveCall({
        target: UNSTAKE,
        typeArguments: ['0x2::sui::SUI'],
        arguments: [shared(tx, '0x5'), shared(tx, HAEDAL_STAKING), ownedCoin(tx)],
      })
    })
    expect(() => check(transaction)).toThrow(/token/)
  })

  it('refuses a payload that is not a Sui transaction', () => {
    expect(() => haedalVenue.assertSafe({ family: 'solana', transaction: 'AA==' }, ME)).toThrow(
      ChainActionRefused
    )
    expect(() => check('not base64 at all!')).toThrow(ChainActionRefused)
  })

  it('refuses a call with the wrong number of arguments', async () => {
    const transaction = await built((tx) => {
      tx.moveCall({ target: UNSTAKE, arguments: [shared(tx, '0x5')] })
    })
    expect(() => check(transaction)).toThrow(/in a way/)
  })

  it('leaves an unpinned call alone in assertPinnedObjects', async () => {
    const transaction = await built(goodStake)
    expect(() =>
      assertPinnedObjects({ family: 'sui', transaction }, new Map(), 'Haedal')
    ).not.toThrow()
  })
})

describe('building a Haedal stake', () => {
  it('refuses a token that is not SUI', async () => {
    await expect(
      haedalVenue.prepare({ kind: 'stake', amount: '1', tokenIn: 'USDC' }, ME)
    ).rejects.toThrow(/stakes SUI/)
    expect(mocks.built).toHaveLength(0)
  })

  it('refuses under the contract’s minimum', async () => {
    await expect(
      haedalVenue.prepare({ kind: 'stake', amount: '0.5', tokenIn: 'SUI' }, ME)
    ).rejects.toThrow(/at least 1 SUI/)
  })

  it('refuses a bad account before anything else', async () => {
    await expect(
      haedalVenue.prepare({ kind: 'stake', amount: '1', tokenIn: 'SUI' }, 'nope')
    ).rejects.toThrow(/Sui address/)
  })

  it('reads the minted haSUI from the dry run and shows the fee it read', async () => {
    mocks.bytes = await built(goodStake)
    mocks.simulate.mockResolvedValue({
      Transaction: {
        balanceChanges: [
          { coinType: '0x2::sui::SUI', address: ME, amount: '-1000000000' },
          { coinType: HASUI_TYPE, address: ME, amount: '924000000' },
        ],
      },
    })
    const prepared = await haedalVenue.prepare({ kind: 'stake', amount: '1', tokenIn: 'SUI' }, ME)
    expect(prepared.receive).toEqual({ amount: '0.924', symbol: 'haSUI', approximate: true })
    const notes = prepared.notes.join(' ')
    expect(notes).toMatch(/keeps 6%/)
    expect(notes).toMatch(/fee of 0.02%/)
    expect(notes).toMatch(/\$915K in June 2026/)
    expect(notes).toMatch(/could not confirm/)
    const data = mocks.built[0]?.getData()
    const targets = data?.commands.flatMap((c) =>
      c.$kind === 'MoveCall' ? [c.MoveCall.function] : []
    )
    expect(targets).toEqual(['request_stake_coin'])
    expect(prepared.apy).toBeUndefined()
  })

  it('refuses when the dry run credits no haSUI to this account', async () => {
    mocks.bytes = await built(goodStake)
    mocks.simulate.mockResolvedValue({
      Transaction: { balanceChanges: [{ coinType: HASUI_TYPE, address: THIEF, amount: '5' }] },
    })
    await expect(
      haedalVenue.prepare({ kind: 'stake', amount: '1', tokenIn: 'SUI' }, ME)
    ).rejects.toThrow(/couldn't confirm/)
  })

  it('quotes the same reading, with no rate', async () => {
    mocks.bytes = await built(goodStake)
    mocks.simulate.mockResolvedValue({
      Transaction: { balanceChanges: [{ coinType: HASUI_TYPE, address: ME, amount: '924000000' }] },
    })
    const quote = await haedalVenue.quote?.({ kind: 'stake', amount: '1', tokenIn: 'SUI' }, ME)
    expect(quote).toEqual({ receive: { amount: '0.924', symbol: 'haSUI' } })
  })
})

describe('building a Haedal unstake', () => {
  const u64 = (n: string) => bcs.u64().serialize(n).toBytes()
  const coin = (n: string) =>
    bcs
      .struct('Coin', { id: bcs.Address, value: bcs.u64() })
      .serialize({ id: FOREIGN, value: n })
      .toBytes()

  function answers(value: string, payout: string | undefined): void {
    mocks.simulate.mockImplementation(async ({ transaction }: { transaction: unknown }) =>
      transaction instanceof Transaction
        ? { Transaction: {}, commandResults: [{ returnValues: [{ bcs: u64(value) }] }] }
        : {
            Transaction: {},
            commandResults: [{ returnValues: payout === undefined ? [] : [{ bcs: coin(payout) }] }],
          }
    )
  }

  it('refuses a token that is not haSUI', async () => {
    await expect(
      haedalVenue.prepare({ kind: 'unstake', amount: '1', tokenIn: 'afSUI' }, ME)
    ).rejects.toThrow(/unstakes haSUI/)
  })

  it('refuses under 1 SUI of value, as the contract would', async () => {
    answers('999999999', '999799999')
    await expect(
      haedalVenue.prepare({ kind: 'unstake', amount: '0.9', tokenIn: 'haSUI' }, ME)
    ).rejects.toThrow(/at least 1 SUI worth/)
    expect(mocks.built).toHaveLength(0)
  })

  it('refuses when the value cannot be read', async () => {
    mocks.simulate.mockResolvedValue({ Transaction: {}, commandResults: [] })
    await expect(
      haedalVenue.prepare({ kind: 'unstake', amount: '2', tokenIn: 'haSUI' }, ME)
    ).rejects.toThrow(/couldn't read/)
  })

  it('reads the SUI from the coin the call returned, not the wallet’s balance change', async () => {
    mocks.bytes = await built(goodUnstake)
    answers('2162000000', '2161567600')
    const prepared = await haedalVenue.prepare(
      { kind: 'unstake', amount: '2', tokenIn: 'haSUI' },
      ME
    )
    expect(prepared.kind).toBe('unstake')
    expect(prepared.pay).toEqual({ amount: '2', symbol: 'haSUI' })
    expect(prepared.receive).toEqual({ amount: '2.161567', symbol: 'SUI', approximate: true })
    expect(prepared.notes.join(' ')).toMatch(/instant unstake/)
    expect(prepared.notes.join(' ')).toMatch(/0.02%/)
    expect(prepared.notes.join(' ')).toMatch(/separate claim/)
    const targets = mocks.built[0]
      ?.getData()
      .commands.flatMap((c) => (c.$kind === 'MoveCall' ? [c.MoveCall.function] : []))
    expect(targets).toEqual(['request_unstake_instant_coin'])
  })

  it('refuses when the dry run shows no payout', async () => {
    mocks.bytes = await built(goodUnstake)
    answers('2162000000', undefined)
    await expect(
      haedalVenue.prepare({ kind: 'unstake', amount: '2', tokenIn: 'haSUI' }, ME)
    ).rejects.toThrow(/couldn't confirm/)
  })

  it('refuses when the fee cannot be read, rather than leaving it off the card', async () => {
    mocks.bytes = await built(goodUnstake)
    answers('2162000000', '2161567600')
    mocks.getObjects.mockResolvedValue({ objects: [{ json: { config: {} } }] })
    await expect(
      haedalVenue.prepare({ kind: 'unstake', amount: '2', tokenIn: 'haSUI' }, ME)
    ).rejects.toThrow(/fees/)
  })
})

describe('after a swap', () => {
  it('stakes SUI only, and never unstakes', async () => {
    await expect(
      haedalVenue.assertCanFollow?.({ kind: 'stake', tokenIn: 'SUI' }, ME)
    ).resolves.toBeUndefined()
    await expect(
      haedalVenue.assertCanFollow?.({ kind: 'stake', tokenIn: 'USDC' }, ME)
    ).rejects.toThrow(/takes SUI/)
    await expect(
      haedalVenue.assertCanFollow?.({ kind: 'unstake', tokenIn: 'SUI' }, ME)
    ).rejects.toThrow(/only stake/)
  })
})

describe('helpers', () => {
  it('finds the coin a call returned by its place in the transaction', async () => {
    const transaction = await built(goodUnstake)
    const coinBytes = bcs
      .struct('Coin', { id: bcs.Address, value: bcs.u64() })
      .serialize({ id: FOREIGN, value: '7' })
      .toBytes()
    expect(returnedCoinAmount([{ returnValues: [{ bcs: coinBytes }] }], transaction, UNSTAKE)).toBe(
      '7'
    )
    expect(returnedCoinAmount([], transaction, UNSTAKE)).toBeUndefined()
    expect(returnedCoinAmount(undefined, transaction, STAKE)).toBeUndefined()
  })

  it('never reads a debit as a credit', () => {
    expect(
      creditedAmount([{ coinType: HASUI_TYPE, address: ME, amount: '-5' }], HASUI_TYPE, ME)
    ).toBeUndefined()
  })

  it('writes small rates plainly', () => {
    expect(percentText(0.02)).toBe('0.02')
    expect(percentText(0.3365)).toBe('0.34')
    expect(percentText(6)).toBe('6')
    expect(percentText(0.001)).toBe('under 0.01')
  })

  it('lists haSUI with the decimals its metadata gives', () => {
    expect(HAEDAL_TOKENS).toEqual([expect.objectContaining({ symbol: 'haSUI', decimals: 9 })])
  })
})
