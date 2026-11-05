import { bcs } from '@mysten/sui/bcs'
import { Inputs, Transaction } from '@mysten/sui/transactions'
import { toBase64 } from '@mysten/sui/utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AFSUI_TYPE,
  AFTERMATH_PACKAGE,
  AFTERMATH_REFERRAL_VAULT,
  AFTERMATH_SAFE,
  AFTERMATH_TOKENS,
  AFTERMATH_VALIDATOR,
  AFTERMATH_VAULT,
  aftermathVenue,
} from '../chains/sui/aftermath'
import { ChainActionRefused } from '../chains/types'

const ME = '0x1111111111111111111111111111111111111111111111111111111111111111'
const THIEF = '0x000000000000000000000000000000000000000000000000000000000000dead'
const FOREIGN = '0x00000000000000000000000000000000000000000000000000000000000bad01'
const DIGEST = '11111111111111111111111111111111'

const mocks = vi.hoisted(() => ({
  simulate: vi.fn(),
  getObjects: vi.fn(),
  systemState: vi.fn(),
  built: [] as Transaction[],
  bytes: '',
}))

vi.mock('../chains/sui/client', async (original) => ({
  ...(await original<typeof import('../chains/sui/client')>()),
  suiClient: () => ({
    core: {
      simulateTransaction: mocks.simulate,
      getObjects: mocks.getObjects,
      getCurrentSystemState: mocks.systemState,
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

const VAULT_CALLS = `${AFTERMATH_PACKAGE}::staked_sui_vault`

interface StakeOptions {
  validator?: string
  vault?: string
  safe?: string
  referral?: string
  to?: string
}

function goodStake(tx: Transaction, options: StakeOptions = {}): void {
  const [sui] = tx.splitCoins(tx.gas, [BigInt(1_000_000_000)])
  const [minted] = tx.moveCall({
    target: `${VAULT_CALLS}::request_stake`,
    arguments: [
      shared(tx, options.vault ?? AFTERMATH_VAULT),
      shared(tx, options.safe ?? AFTERMATH_SAFE),
      shared(tx, '0x5'),
      shared(tx, options.referral ?? AFTERMATH_REFERRAL_VAULT),
      sui as never,
      tx.pure.address(options.validator ?? AFTERMATH_VALIDATOR),
    ],
  })
  tx.transferObjects([minted as never], options.to ?? ME)
}

function goodUnstake(tx: Transaction, vault: string = AFTERMATH_VAULT): void {
  tx.moveCall({
    target: `${VAULT_CALLS}::request_unstake`,
    arguments: [
      shared(tx, vault),
      shared(tx, AFTERMATH_SAFE),
      tx.object(Inputs.ObjectRef({ objectId: THIEF, version: 1, digest: DIGEST })),
    ],
  })
}

function check(transaction: string, account: string = ME): void {
  aftermathVenue.assertSafe({ family: 'sui', transaction }, account)
}

const STATE = {
  total_rewards_amount: '198164944580303',
  total_sui_amount: '2944756051147434',
  protocol_config: {
    min_staking_threshold: '1000000000',
    default_unstake_protocol_fee: { total_fee: '50000000000000000' },
  },
}

beforeEach(() => {
  mocks.simulate.mockReset()
  mocks.getObjects.mockReset()
  mocks.systemState.mockReset()
  mocks.built.length = 0
  mocks.getObjects.mockResolvedValue({ objects: [{ json: STATE }] })
  mocks.systemState.mockResolvedValue({
    systemState: {
      epochStartTimestampMs: String(Date.now() - 20 * 3_600_000),
      parameters: { epochDurationMs: '86400000' },
    },
  })
})

describe('Aftermath safety on what the wallet would sign', () => {
  it('passes the stake and the unstake it builds', async () => {
    await expect(built(goodStake).then(check)).resolves.toBeUndefined()
    await expect(built(goodUnstake).then(check)).resolves.toBeUndefined()
  })

  it('refuses the wrong account', async () => {
    const transaction = await built(goodStake)
    expect(() => check(transaction, THIEF)).toThrow(/different account/)
  })

  it('refuses an unknown contract', async () => {
    const transaction = await built((tx) => {
      goodUnstake(tx)
      tx.moveCall({ target: `${FOREIGN}::drain::everything` })
    })
    expect(() => check(transaction)).toThrow(/confirmed/)
  })

  it.each([
    'request_unstake_atomic',
    'request_unstake_atomic_and_keep',
    'request_stake_and_keep',
    'request_stake_staked_sui',
    'epoch_was_changed',
    'update_default_unstake_total_fee',
  ])('refuses %s, which this flow never uses', async (fn) => {
    const transaction = await built((tx) => {
      tx.moveCall({ target: `${VAULT_CALLS}::${fn}` })
    })
    expect(() => check(transaction)).toThrow(/confirmed/)
  })

  it('refuses perps and pools, which are other contracts', async () => {
    const transaction = await built((tx) => {
      tx.moveCall({
        target: '0xf948935b111990c2b604900c9b2eeb8f24dcf9868a45d1ea1653a5f282c10e29::pool::swap',
      })
    })
    expect(() => check(transaction)).toThrow(/confirmed/)
  })

  it('refuses the same call in the old package', async () => {
    const transaction = await built((tx) => {
      tx.moveCall({
        target:
          '0x7f6ce7ade63857c4fd16ef7783fed2dfc4d7fb7e40615abdb653030b76aef0c6::staked_sui_vault::request_unstake',
      })
    })
    expect(() => check(transaction)).toThrow(/confirmed/)
  })

  it('refuses extra steps', async () => {
    const transaction = await built((tx) => {
      goodUnstake(tx)
      tx.publish({ modules: ['AA=='], dependencies: ['0x1', '0x2'] })
    })
    expect(() => check(transaction)).toThrow(/Publish/)
  })

  it('refuses afSUI paid to someone else', async () => {
    const transaction = await built((tx) => goodStake(tx, { to: THIEF }))
    expect(() => check(transaction)).toThrow(/another address/)
  })

  it.each([
    ['vault', { vault: FOREIGN }],
    ['treasury safe', { safe: FOREIGN }],
    ['referral vault', { referral: FOREIGN }],
  ])('refuses a %s other than Aftermath’s', async (_name, options) => {
    const transaction = await built((tx) => goodStake(tx, options))
    expect(() => check(transaction)).toThrow(/object/)
  })

  it('refuses an unstake against another vault', async () => {
    const transaction = await built((tx) => goodUnstake(tx, FOREIGN))
    expect(() => check(transaction)).toThrow(/object/)
  })

  it('refuses a validator it did not choose, which could take a fee of up to 5%', async () => {
    const transaction = await built((tx) => goodStake(tx, { validator: THIEF }))
    expect(() => check(transaction)).toThrow(/validator/)
  })

  it('refuses a call that names a token', async () => {
    const transaction = await built((tx) => {
      tx.moveCall({ target: `${VAULT_CALLS}::request_unstake`, typeArguments: ['0x2::sui::SUI'] })
    })
    expect(() => check(transaction)).toThrow(ChainActionRefused)
  })
})

describe('building an Aftermath stake', () => {
  it('refuses a token that is not SUI', async () => {
    await expect(
      aftermathVenue.prepare({ kind: 'stake', amount: '1', tokenIn: 'USDC' }, ME)
    ).rejects.toThrow(/stakes SUI/)
  })

  it('refuses under the minimum the vault reports', async () => {
    await expect(
      aftermathVenue.prepare({ kind: 'stake', amount: '0.5', tokenIn: 'SUI' }, ME)
    ).rejects.toThrow(/at least 1 SUI/)
    expect(mocks.built).toHaveLength(0)
  })

  it('refuses when the vault cannot be read', async () => {
    mocks.getObjects.mockResolvedValue({ objects: [{ json: {} }] })
    await expect(
      aftermathVenue.prepare({ kind: 'stake', amount: '1', tokenIn: 'SUI' }, ME)
    ).rejects.toThrow(/fees/)
  })

  it('reads the minted afSUI from the dry run, and says what getting out costs', async () => {
    mocks.bytes = await built(goodStake)
    mocks.simulate.mockResolvedValue({
      Transaction: {
        balanceChanges: [{ coinType: AFSUI_TYPE, address: ME, amount: '928000000' }],
      },
    })
    const prepared = await aftermathVenue.prepare(
      { kind: 'stake', amount: '1', tokenIn: 'SUI' },
      ME
    )
    expect(prepared.receive).toEqual({ amount: '0.928', symbol: 'afSUI', approximate: true })
    expect(prepared.apy).toBeUndefined()
    const notes = prepared.notes.join(' ')
    expect(notes).toMatch(/about 0.34%/)
    expect(notes).toMatch(/next Sui epoch/)
    expect(notes).toMatch(/\$1.14M in April 2026/)
    expect(notes).toMatch(/single signer/)
  })

  it('refuses when the dry run credits no afSUI', async () => {
    mocks.bytes = await built(goodStake)
    mocks.simulate.mockResolvedValue({ Transaction: { balanceChanges: [] } })
    await expect(
      aftermathVenue.prepare({ kind: 'stake', amount: '1', tokenIn: 'SUI' }, ME)
    ).rejects.toThrow(/couldn't confirm/)
  })
})

describe('building an Aftermath unstake', () => {
  const u64 = (n: string) => bcs.u64().serialize(n).toBytes()

  function answers(value: string | undefined, succeeds = true): void {
    mocks.simulate.mockImplementation(async ({ transaction }: { transaction: unknown }) =>
      transaction instanceof Transaction
        ? {
            Transaction: {},
            commandResults: [{ returnValues: value === undefined ? [] : [{ bcs: u64(value) }] }],
          }
        : succeeds
          ? { Transaction: {}, commandResults: [] }
          : { FailedTransaction: {}, commandResults: [] }
    )
  }

  it('refuses a token that is not afSUI', async () => {
    await expect(
      aftermathVenue.prepare({ kind: 'unstake', amount: '1', tokenIn: 'sSUI' }, ME)
    ).rejects.toThrow(/unstakes afSUI/)
  })

  it('refuses under 1 SUI of value', async () => {
    answers('999999999')
    await expect(
      aftermathVenue.prepare({ kind: 'unstake', amount: '0.9', tokenIn: 'afSUI' }, ME)
    ).rejects.toThrow(/at least 1 SUI worth/)
  })

  it('refuses when the value cannot be read', async () => {
    answers(undefined)
    await expect(
      aftermathVenue.prepare({ kind: 'unstake', amount: '2', tokenIn: 'afSUI' }, ME)
    ).rejects.toThrow(/couldn't read/)
  })

  it('takes the fee the contract would take, as a real payout did', async () => {
    mocks.bytes = await built(goodUnstake)
    // A real delayed payout: 28.144751941 SUI by the rate, 28.050100069 reached the wallet.
    answers('28144751941')
    const prepared = await aftermathVenue.prepare(
      { kind: 'unstake', amount: '26.142139341', tokenIn: 'afSUI' },
      ME
    )
    const shown = Number(prepared.receive?.amount)
    expect(Math.abs(shown - 28.050100069)).toBeLessThan(0.001)
    expect(prepared.pay).toEqual({ amount: '26.142139341', symbol: 'afSUI' })
    expect(prepared.receive?.approximate).toBe(true)
  })

  it('says the SUI comes later, and how long, from the chain’s epoch', async () => {
    mocks.bytes = await built(goodUnstake)
    answers('2000000000')
    const prepared = await aftermathVenue.prepare(
      { kind: 'unstake', amount: '2', tokenIn: 'afSUI' },
      ME
    )
    const notes = prepared.notes.join(' ')
    expect(notes).toMatch(/does not come in this transaction/)
    expect(notes).toMatch(/in about 4 hours/)
    expect(notes).toMatch(/can't be cancelled/)
    expect(notes).toMatch(/You sign nothing more/)
    expect(notes).toMatch(/about 0.34%/)
    const data = mocks.built[0]?.getData()
    const targets = data?.commands.flatMap((c) =>
      c.$kind === 'MoveCall' ? [c.MoveCall.function] : []
    )
    expect(targets).toEqual(['request_unstake'])
    expect(data?.commands.some((c) => c.$kind === 'TransferObjects')).toBe(false)
  })

  it('refuses when the dry run fails, such as while the vault processes an epoch', async () => {
    mocks.bytes = await built(goodUnstake)
    answers('2000000000', false)
    await expect(
      aftermathVenue.prepare({ kind: 'unstake', amount: '2', tokenIn: 'afSUI' }, ME)
    ).rejects.toThrow(/would fail/)
  })

  it('refuses when the epoch cannot be read', async () => {
    mocks.bytes = await built(goodUnstake)
    answers('2000000000')
    mocks.systemState.mockResolvedValue({
      systemState: { epochStartTimestampMs: 'x', parameters: { epochDurationMs: '0' } },
    })
    await expect(
      aftermathVenue.prepare({ kind: 'unstake', amount: '2', tokenIn: 'afSUI' }, ME)
    ).rejects.toThrow(/epoch/)
  })
})

describe('after a swap', () => {
  it('stakes SUI only, and never unstakes', async () => {
    await expect(
      aftermathVenue.assertCanFollow?.({ kind: 'stake', tokenIn: 'SUI' }, ME)
    ).resolves.toBeUndefined()
    await expect(
      aftermathVenue.assertCanFollow?.({ kind: 'unstake', tokenIn: 'SUI' }, ME)
    ).rejects.toThrow(/only stake/)
  })
})

it('lists afSUI with the decimals its metadata gives', () => {
  expect(AFTERMATH_TOKENS).toEqual([expect.objectContaining({ symbol: 'afSUI', decimals: 9 })])
})
