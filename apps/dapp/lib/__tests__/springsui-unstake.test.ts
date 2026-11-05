import { bcs } from '@mysten/sui/bcs'
import { Inputs, Transaction } from '@mysten/sui/transactions'
import { toBase64 } from '@mysten/sui/utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CAPTURED_SENDER, CAPTURED_SPRINGSUI_STAKE } from '../chains/sui/captured-transactions'
import { SPRINGSUI_PACKAGE, SSUI_INFO, SSUI_TYPE, SSUI_WEIGHT_HOOK } from '../chains/sui/policies'
import { springsuiVenue } from '../chains/sui/springsui'
import { SPRINGSUI_TOKENS } from '../chains/sui/springsui-unstake'
import { ChainActionRefused } from '../chains/types'

const ME = '0x1111111111111111111111111111111111111111111111111111111111111111'
const THIEF = '0x000000000000000000000000000000000000000000000000000000000000dead'
const FOREIGN = '0x00000000000000000000000000000000000000000000000000000000000bad01'
const DIGEST = '11111111111111111111111111111111'
const OTHER_LST = '0x460c669acd3f294dc4247a6877ec2532340ffde76162ab201e72fe95355830e7::asui::ASUI'

const mocks = vi.hoisted(() => ({
  simulate: vi.fn(),
  getObjects: vi.fn(),
  getBalance: vi.fn(),
  built: [] as Transaction[],
  bytes: '',
}))

vi.mock('../chains/sui/client', async (original) => ({
  ...(await original<typeof import('../chains/sui/client')>()),
  suiClient: () => ({
    core: {
      simulateTransaction: mocks.simulate,
      getObjects: mocks.getObjects,
      getBalance: mocks.getBalance,
    },
  }),
  buildUnsigned: async (tx: Transaction) => {
    mocks.built.push(tx)
    return mocks.bytes
  },
}))

function shared(tx: Transaction, objectId: string) {
  return tx.object(Inputs.SharedObjectRef({ objectId, initialSharedVersion: 1, mutable: true }))
}

async function built(edit: (tx: Transaction) => void, sender: string = ME): Promise<string> {
  const tx = new Transaction()
  tx.setSender(sender)
  tx.setGasOwner(sender)
  tx.setGasPrice(1000)
  tx.setGasBudget(10_000_000)
  tx.setGasPayment([{ objectId: FOREIGN, version: 1, digest: DIGEST }])
  edit(tx)
  return toBase64(await tx.build())
}

interface Options {
  coinType?: string
  info?: string
  to?: string
}

function goodRedeem(tx: Transaction, options: Options = {}): void {
  const coinType = options.coinType ?? SSUI_TYPE
  const info = options.info ?? SSUI_INFO
  const [sui] = tx.moveCall({
    target: `${SPRINGSUI_PACKAGE}::liquid_staking::redeem`,
    typeArguments: [coinType],
    arguments: [
      shared(tx, info),
      tx.object(Inputs.ObjectRef({ objectId: THIEF, version: 1, digest: DIGEST })),
      shared(tx, '0x5'),
    ],
  })
  tx.moveCall({
    target: `${SPRINGSUI_PACKAGE}::weight::rebalance`,
    typeArguments: [coinType],
    arguments: [shared(tx, SSUI_WEIGHT_HOOK), shared(tx, '0x5'), shared(tx, info)],
  })
  tx.transferObjects([sui as never], options.to ?? ME)
}

function check(transaction: string, account: string = ME): void {
  springsuiVenue.assertSafe({ family: 'sui', transaction }, account)
}

const u64Coin = (n: string) =>
  bcs
    .struct('Coin', { id: bcs.Address, value: bcs.u64() })
    .serialize({ id: FOREIGN, value: n })
    .toBytes()

beforeEach(() => {
  mocks.simulate.mockReset()
  mocks.getObjects.mockReset()
  mocks.built.length = 0
  mocks.getObjects.mockResolvedValue({
    objects: [{ json: { fee_config: { element: { redeem_fee_bps: '2' } } } }],
  })
})

describe('SpringSui unstake safety on what the wallet would sign', () => {
  it('passes the redeem it builds', async () => {
    await expect(built(goodRedeem).then(check)).resolves.toBeUndefined()
  })

  it('still passes the stake it built before', () => {
    expect(() =>
      springsuiVenue.assertSafe(
        { family: 'sui', transaction: CAPTURED_SPRINGSUI_STAKE },
        CAPTURED_SENDER
      )
    ).not.toThrow()
  })

  it('refuses a redeem and a mint in one transaction', async () => {
    const transaction = await built((tx) => {
      goodRedeem(tx)
      tx.moveCall({
        target: `${SPRINGSUI_PACKAGE}::liquid_staking::mint`,
        typeArguments: [SSUI_TYPE],
      })
    })
    expect(() => check(transaction)).toThrow(/confirmed/)
  })

  it('refuses the wrong account', async () => {
    const transaction = await built(goodRedeem)
    expect(() => check(transaction, THIEF)).toThrow(/different account/)
  })

  it('refuses an unknown contract', async () => {
    const transaction = await built((tx) => {
      goodRedeem(tx)
      tx.moveCall({ target: `${FOREIGN}::drain::everything` })
    })
    expect(() => check(transaction)).toThrow(/confirmed/)
  })

  it.each(['custom_redeem', 'custom_redeem_request', 'collect_fees', 'update_fees'])(
    'refuses %s, which this flow never uses',
    async (fn) => {
      const transaction = await built((tx) => {
        goodRedeem(tx)
        tx.moveCall({
          target: `${SPRINGSUI_PACKAGE}::liquid_staking::${fn}`,
          typeArguments: [SSUI_TYPE],
        })
      })
      expect(() => check(transaction)).toThrow(/confirmed/)
    }
  )

  it('refuses extra steps', async () => {
    const transaction = await built((tx) => {
      goodRedeem(tx)
      tx.publish({ modules: ['AA=='], dependencies: ['0x1', '0x2'] })
    })
    expect(() => check(transaction)).toThrow(/Publish/)
  })

  it('refuses the SUI paid to someone else', async () => {
    const transaction = await built((tx) => goodRedeem(tx, { to: THIEF }))
    expect(() => check(transaction)).toThrow(/another address/)
  })

  it('refuses a token other than sSUI', async () => {
    const transaction = await built((tx) => goodRedeem(tx, { coinType: OTHER_LST }))
    expect(() => check(transaction)).toThrow(/sSUI/)
  })

  it('refuses a pool other than sSUI’s', async () => {
    const transaction = await built((tx) => goodRedeem(tx, { info: FOREIGN }))
    expect(() => check(transaction)).toThrow(/object/)
  })

  it('refuses a rebalance against another hook', async () => {
    const transaction = await built((tx) => {
      goodRedeem(tx)
      tx.moveCall({
        target: `${SPRINGSUI_PACKAGE}::weight::rebalance`,
        typeArguments: [SSUI_TYPE],
        arguments: [shared(tx, FOREIGN), shared(tx, '0x5'), shared(tx, SSUI_INFO)],
      })
    })
    expect(() => check(transaction)).toThrow(/object/)
  })

  it('refuses a payload that is not a Sui transaction', () => {
    expect(() => springsuiVenue.assertSafe({ family: 'solana', transaction: 'AA==' }, ME)).toThrow(
      ChainActionRefused
    )
    expect(() => check('not base64 at all!')).toThrow(ChainActionRefused)
  })
})

describe('building a SpringSui unstake', () => {
  it('refuses a token that is not sSUI, and says how to name the right app', async () => {
    await expect(
      springsuiVenue.prepare({ kind: 'unstake', amount: '1', tokenIn: 'haSUI' }, ME)
    ).rejects.toThrow(/name it/)
    expect(mocks.built).toHaveLength(0)
  })

  it('refuses a bad account', async () => {
    await expect(
      springsuiVenue.prepare({ kind: 'unstake', amount: '1', tokenIn: 'sSUI' }, 'nope')
    ).rejects.toThrow(/Sui address/)
  })

  it('reads the SUI from the coin returned, and the fee it read', async () => {
    mocks.bytes = await built(goodRedeem)
    mocks.simulate.mockResolvedValue({
      Transaction: { balanceChanges: [] },
      commandResults: [{ returnValues: [{ bcs: u64Coin('2075784416') }] }],
    })
    const prepared = await springsuiVenue.prepare(
      { kind: 'unstake', amount: '2', tokenIn: 'sSUI' },
      ME
    )
    expect(prepared.kind).toBe('unstake')
    expect(prepared.pay).toEqual({ amount: '2', symbol: 'sSUI' })
    expect(prepared.receive).toEqual({ amount: '2.075784', symbol: 'SUI', approximate: true })
    expect(prepared.notes.join(' ')).toMatch(/no wait/)
    expect(prepared.notes.join(' ')).toMatch(/0.02%/)
    const targets = mocks.built[0]
      ?.getData()
      .commands.flatMap((c) => (c.$kind === 'MoveCall' ? [c.MoveCall.function] : []))
    expect(targets).toEqual(['redeem', 'rebalance'])
  })

  it('refuses when the dry run shows no payout', async () => {
    mocks.bytes = await built(goodRedeem)
    mocks.simulate.mockResolvedValue({ Transaction: {}, commandResults: [] })
    await expect(
      springsuiVenue.prepare({ kind: 'unstake', amount: '2', tokenIn: 'sSUI' }, ME)
    ).rejects.toThrow(/couldn't confirm/)
  })

  it('refuses when the fee cannot be read', async () => {
    mocks.bytes = await built(goodRedeem)
    mocks.simulate.mockResolvedValue({
      Transaction: {},
      commandResults: [{ returnValues: [{ bcs: u64Coin('2075784416') }] }],
    })
    mocks.getObjects.mockResolvedValue({ objects: [{ json: {} }] })
    await expect(
      springsuiVenue.prepare({ kind: 'unstake', amount: '2', tokenIn: 'sSUI' }, ME)
    ).rejects.toThrow(/fee/)
  })
})

describe('what SpringSui positions report', () => {
  beforeEach(() => {
    mocks.getBalance.mockReset()
  })

  it('counts sSUI in the wallet as staked, to the last unit', async () => {
    mocks.getBalance.mockResolvedValue({ balance: { balance: '1234567891' } })
    expect(await springsuiVenue.positions?.(ME)).toEqual([
      { slot: 'staked', symbol: 'sSUI', amount: '1.234567891' },
    ])
    expect(mocks.getBalance).toHaveBeenCalledWith({ owner: ME, coinType: SSUI_TYPE })
  })

  it('reads a real zero as nothing there', async () => {
    mocks.getBalance.mockResolvedValue({ balance: { balance: '0' } })
    expect(await springsuiVenue.positions?.(ME)).toEqual([])
  })

  it('throws when it can not read, never an empty list', async () => {
    mocks.getBalance.mockRejectedValue(new Error('rpc down'))
    await expect(springsuiVenue.positions?.(ME)).rejects.toThrow('rpc down')
  })

  it('throws on a balance that is no number', async () => {
    mocks.getBalance.mockResolvedValue({ balance: {} })
    await expect(springsuiVenue.positions?.(ME)).rejects.toThrow(/unreadable/)
  })

  it('throws on a malformed account', async () => {
    await expect(springsuiVenue.positions?.('nope')).rejects.toThrow(ChainActionRefused)
  })

  it('empties the whole position to the last unit', async () => {
    mocks.bytes = await built(goodRedeem)
    mocks.simulate.mockResolvedValue({
      Transaction: { balanceChanges: [] },
      commandResults: [{ returnValues: [{ bcs: u64Coin('2075784416') }] }],
    })
    await springsuiVenue.prepare(
      { kind: 'unstake', amount: '1.234567891', wholePosition: true, tokenIn: 'sSUI' },
      ME
    )
    const coin = mocks.built[0]?.getData().commands[0]
    expect(coin?.$kind).toBe('$Intent')
    expect(coin?.$kind === '$Intent' ? coin.$Intent.data['balance'] : undefined).toBe(
      BigInt('1234567891')
    )
  })
})

describe('the venue as a whole', () => {
  it('does both, and follows a swap only to stake', async () => {
    expect(springsuiVenue.kinds).toEqual(['stake', 'unstake'])
    await expect(
      springsuiVenue.assertCanFollow?.({ kind: 'stake', tokenIn: 'SUI' }, ME)
    ).resolves.toBeUndefined()
    await expect(
      springsuiVenue.assertCanFollow?.({ kind: 'unstake', tokenIn: 'sSUI' }, ME)
    ).rejects.toThrow(/only stake/)
  })

  it('lists sSUI with the decimals its metadata gives', () => {
    expect(SPRINGSUI_TOKENS).toEqual([expect.objectContaining({ symbol: 'sSUI', decimals: 9 })])
  })
})
