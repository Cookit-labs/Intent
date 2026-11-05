import { describe, expect, it } from 'vitest'

import {
  assertMetapoolSafe,
  assertOneClickSafe,
  assertRnearSafe,
  STORAGE_DEPOSIT_YOCTO,
} from '../chains/near/safety'
import { METAPOOL_CONTRACT, RNEAR_CONTRACT, USDC_NEAR, WRAP_NEAR } from '../chains/near/tokens'
import { ChainActionRefused, type NearTransaction, type SigningPayload } from '../chains/types'

/**
 * A NEAR wallet sends what it signs, so these checks get no second chance. Each
 * test starts from a payload the app really builds and tampers with one thing.
 */

const ME = 'alice.near'
const DEPOSIT = 'dc2c3034e3ebefa1af9a2c419f896d7b761a056244099eefcd09aeb7efc1b86d'
const OTHER_DEPOSIT = '30ea8641492a90c05b53a337b51d66ed05118eaa9065bb7bb032bb2cea75e034'
const TG30 = '30000000000000'
const ONE_NEAR = '1000000000000000000000000'

type Action = NearTransaction['actions'][number]

function call(
  methodName: string,
  args: Record<string, unknown>,
  deposit: string,
  gas = TG30
): Action {
  return { type: 'FunctionCall', params: { methodName, args, gas, deposit } }
}
const storageFor = (account: string): Action =>
  call('storage_deposit', { account_id: account, registration_only: true }, STORAGE_DEPOSIT_YOCTO)
const transfer = (amount = '1000000', to = DEPOSIT): Action =>
  call('ft_transfer', { receiver_id: to, amount }, '1')
const stake = (deposit = ONE_NEAR, gas = '100000000000000'): Action =>
  call('deposit_and_stake', {}, deposit, gas)

function payload(receiverId: string, actions: Action[]): SigningPayload {
  return { family: 'near', transactions: [{ receiverId, actions }] }
}

const usdcDeposit = (): SigningPayload => payload(USDC_NEAR, [storageFor(DEPOSIT), transfer()])
const nearDeposit = (): SigningPayload =>
  payload(WRAP_NEAR, [
    storageFor(ME),
    call('near_deposit', {}, ONE_NEAR),
    storageFor(DEPOSIT),
    transfer(ONE_NEAR),
  ])

function refused(fn: () => void): void {
  expect(fn).toThrow(ChainActionRefused)
}

describe('assertOneClickSafe accepts what the app builds', () => {
  it('passes a stablecoin deposit, with and without a storage payment', () => {
    expect(() => assertOneClickSafe(usdcDeposit(), ME)).not.toThrow()
    expect(() => assertOneClickSafe(payload(USDC_NEAR, [transfer()]), ME)).not.toThrow()
  })

  it('passes a wrap and deposit, with and without registering the sender', () => {
    expect(() => assertOneClickSafe(nearDeposit(), ME)).not.toThrow()
    expect(() =>
      assertOneClickSafe(
        payload(WRAP_NEAR, [call('near_deposit', {}, ONE_NEAR), transfer(ONE_NEAR)]),
        ME
      )
    ).not.toThrow()
  })
})

describe('assertOneClickSafe refuses tampering', () => {
  it('refuses another family', () => {
    refused(() => assertOneClickSafe({ family: 'solana', transaction: 'AA==' }, ME))
  })

  it('refuses a foreign receiver contract', () => {
    refused(() => assertOneClickSafe(payload('evil.near', [transfer()]), ME))
    refused(() => assertOneClickSafe(payload('usdt.tether-token.near.evil', [transfer()]), ME))
    refused(() => assertOneClickSafe(payload(RNEAR_CONTRACT, [transfer()]), ME))
  })

  it('refuses a transfer to anything but a 64-hex deposit address', () => {
    refused(() => assertOneClickSafe(payload(USDC_NEAR, [transfer('1000000', 'evil.near')]), ME))
    refused(() =>
      assertOneClickSafe(payload(USDC_NEAR, [transfer('1000000', DEPOSIT.toUpperCase())]), ME)
    )
    refused(() =>
      assertOneClickSafe(payload(USDC_NEAR, [transfer('1000000', DEPOSIT.slice(1))]), ME)
    )
  })

  it('refuses paying your own account as if it were a deposit', () => {
    refused(() => assertOneClickSafe(payload(USDC_NEAR, [transfer('1', DEPOSIT)]), DEPOSIT))
  })

  it('refuses an extra action: a second transfer, before or after', () => {
    refused(() =>
      assertOneClickSafe(payload(USDC_NEAR, [transfer(), transfer('5', OTHER_DEPOSIT)]), ME)
    )
    refused(() =>
      assertOneClickSafe(payload(USDC_NEAR, [transfer('5', OTHER_DEPOSIT), transfer()]), ME)
    )
  })

  it('refuses an extra transaction', () => {
    const [first] = (usdcDeposit() as { transactions: NearTransaction[] }).transactions
    refused(() =>
      assertOneClickSafe(
        { family: 'near', transactions: [first as NearTransaction, first as NearTransaction] },
        ME
      )
    )
    refused(() => assertOneClickSafe({ family: 'near', transactions: [] }, ME))
  })

  it('refuses a foreign method, including the ones that do move money', () => {
    for (const method of [
      'ft_transfer_call',
      'near_withdraw',
      'storage_withdraw',
      'storage_unregister',
      'add_full_access_key',
    ]) {
      refused(() =>
        assertOneClickSafe(
          payload(USDC_NEAR, [call(method, { receiver_id: DEPOSIT, amount: '1' }, '1')]),
          ME
        )
      )
      refused(() =>
        assertOneClickSafe(
          payload(USDC_NEAR, [
            call(method, { receiver_id: DEPOSIT, amount: '1' }, '1'),
            transfer(),
          ]),
          ME
        )
      )
    }
  })

  it('refuses anything but exactly 1 yoctoNEAR on the transfer', () => {
    for (const deposit of ['0', '2', ONE_NEAR]) {
      const tampered = call('ft_transfer', { receiver_id: DEPOSIT, amount: '1000000' }, deposit)
      refused(() => assertOneClickSafe(payload(USDC_NEAR, [tampered]), ME))
    }
  })

  it('refuses extra or missing transfer arguments', () => {
    const memo = call('ft_transfer', { receiver_id: DEPOSIT, amount: '1', memo: 'x' }, '1')
    const noAmount = call('ft_transfer', { receiver_id: DEPOSIT }, '1')
    refused(() => assertOneClickSafe(payload(USDC_NEAR, [memo]), ME))
    refused(() => assertOneClickSafe(payload(USDC_NEAR, [noAmount]), ME))
  })

  it('refuses a zero, malformed or oversized transfer', () => {
    refused(() => assertOneClickSafe(payload(USDC_NEAR, [transfer('0')]), ME))
    refused(() => assertOneClickSafe(payload(USDC_NEAR, [transfer('-1')]), ME))
    refused(() => assertOneClickSafe(payload(USDC_NEAR, [transfer('1.5')]), ME))
    refused(() => assertOneClickSafe(payload(USDC_NEAR, [transfer('10000000001')]), ME))
  })

  it('refuses a storage payment of the wrong size or for a stranger', () => {
    const big = call('storage_deposit', { account_id: DEPOSIT, registration_only: true }, ONE_NEAR)
    refused(() => assertOneClickSafe(payload(USDC_NEAR, [big, transfer()]), ME))
    refused(() => assertOneClickSafe(payload(USDC_NEAR, [storageFor('evil.near'), transfer()]), ME))
    refused(() => assertOneClickSafe(payload(USDC_NEAR, [storageFor(ME), transfer()]), ME))
    const noFlag = call('storage_deposit', { account_id: DEPOSIT }, STORAGE_DEPOSIT_YOCTO)
    refused(() => assertOneClickSafe(payload(USDC_NEAR, [noFlag, transfer()]), ME))
    refused(() =>
      assertOneClickSafe(
        payload(USDC_NEAR, [storageFor(DEPOSIT), storageFor(DEPOSIT), transfer()]),
        ME
      )
    )
  })

  it('refuses a wrap that does not match what is sent', () => {
    refused(() =>
      assertOneClickSafe(
        payload(WRAP_NEAR, [
          call('near_deposit', {}, '2000000000000000000000000'),
          transfer(ONE_NEAR),
        ]),
        ME
      )
    )
    refused(() =>
      assertOneClickSafe(
        payload(WRAP_NEAR, [
          call('near_deposit', {}, ONE_NEAR),
          call('near_deposit', {}, ONE_NEAR),
          transfer(ONE_NEAR),
        ]),
        ME
      )
    )
    refused(() =>
      assertOneClickSafe(payload(USDC_NEAR, [call('near_deposit', {}, '1000000'), transfer()]), ME)
    )
    refused(() => assertOneClickSafe(payload(WRAP_NEAR, [transfer(ONE_NEAR)]), ME))
  })

  it('refuses more gas than the limits', () => {
    const heavy = call(
      'ft_transfer',
      { receiver_id: DEPOSIT, amount: '1000000' },
      '1',
      '30000000000001'
    )
    refused(() => assertOneClickSafe(payload(USDC_NEAR, [heavy]), ME))
    const noGas = call('ft_transfer', { receiver_id: DEPOSIT, amount: '1' }, '1', '0')
    refused(() => assertOneClickSafe(payload(USDC_NEAR, [noGas]), ME))
  })

  it('refuses malformed shapes rather than crashing past them', () => {
    const cases: unknown[] = [
      { family: 'near' },
      { family: 'near', transactions: [null] },
      { family: 'near', transactions: [{ receiverId: USDC_NEAR }] },
      { family: 'near', transactions: [{ receiverId: USDC_NEAR, actions: [] }] },
      {
        family: 'near',
        transactions: [{ receiverId: USDC_NEAR, actions: [{ type: 'Transfer' }] }],
      },
      {
        family: 'near',
        transactions: [{ receiverId: USDC_NEAR, actions: [{ type: 'FunctionCall' }] }],
      },
      {
        family: 'near',
        transactions: [{ receiverId: USDC_NEAR, signerId: 'evil.near', actions: [transfer()] }],
      },
      {
        family: 'near',
        transactions: [
          {
            receiverId: USDC_NEAR,
            actions: [
              {
                type: 'FunctionCall',
                params: {
                  methodName: 'ft_transfer',
                  args: { receiver_id: DEPOSIT, amount: '1' },
                  gas: 30000000000000,
                  deposit: '1',
                },
              },
            ],
          },
        ],
      },
    ]
    for (const each of cases) {
      refused(() => assertOneClickSafe(each as SigningPayload, ME))
    }
  })

  it('refuses a signer that is not a NEAR account', () => {
    refused(() =>
      assertOneClickSafe(usdcDeposit(), 'GAJ74DIC3252BKBTDCEYTDA2ZYDRDBDT3QMZU5IW2HOZQBYVXMRZZEFA')
    )
  })
})

describe('the staking checks', () => {
  it('accepts what each venue builds', () => {
    expect(() =>
      assertRnearSafe(
        payload(RNEAR_CONTRACT, [storageFor(ME), stake(ONE_NEAR, '200000000000000')]),
        ME
      )
    ).not.toThrow()
    expect(() =>
      assertRnearSafe(payload(RNEAR_CONTRACT, [stake(ONE_NEAR, '200000000000000')]), ME)
    ).not.toThrow()
    expect(() => assertMetapoolSafe(payload(METAPOOL_CONTRACT, [stake()]), ME)).not.toThrow()
  })

  it('refuses the other venue, or any foreign receiver', () => {
    refused(() => assertRnearSafe(payload(METAPOOL_CONTRACT, [stake()]), ME))
    refused(() => assertMetapoolSafe(payload(RNEAR_CONTRACT, [stake()]), ME))
    refused(() => assertMetapoolSafe(payload('evil.near', [stake()]), ME))
    refused(() => assertMetapoolSafe(payload(USDC_NEAR, [stake()]), ME))
  })

  it('refuses a foreign method', () => {
    for (const method of [
      'deposit',
      'unstake_all',
      'withdraw_all',
      'ft_transfer',
      'ft_transfer_call',
    ]) {
      refused(() =>
        assertMetapoolSafe(payload(METAPOOL_CONTRACT, [call(method, {}, ONE_NEAR)]), ME)
      )
      refused(() =>
        assertMetapoolSafe(payload(METAPOOL_CONTRACT, [call(method, {}, '1'), stake()]), ME)
      )
    }
  })

  it('refuses an extra action', () => {
    refused(() => assertMetapoolSafe(payload(METAPOOL_CONTRACT, [stake(), stake()]), ME))
    refused(() => assertMetapoolSafe(payload(METAPOOL_CONTRACT, [storageFor(ME), stake()]), ME))
    refused(() =>
      assertRnearSafe(payload(RNEAR_CONTRACT, [storageFor(ME), storageFor(ME), stake()]), ME)
    )
  })

  it('refuses a stake of nothing, or beyond the ceiling of 1,000 NEAR', () => {
    refused(() => assertMetapoolSafe(payload(METAPOOL_CONTRACT, [stake('0')]), ME))
    refused(() =>
      assertMetapoolSafe(payload(METAPOOL_CONTRACT, [stake('1000000000000000000000000001')]), ME)
    )
    expect(() =>
      assertMetapoolSafe(payload(METAPOOL_CONTRACT, [stake('1000000000000000000000000000')]), ME)
    ).not.toThrow()
  })

  it('refuses arguments on the stake, a stranger storage payment and excess gas', () => {
    refused(() =>
      assertMetapoolSafe(
        payload(METAPOOL_CONTRACT, [call('deposit_and_stake', { x: 1 }, ONE_NEAR)]),
        ME
      )
    )
    refused(() => assertRnearSafe(payload(RNEAR_CONTRACT, [storageFor('evil.near'), stake()]), ME))
    refused(() =>
      assertMetapoolSafe(payload(METAPOOL_CONTRACT, [stake(ONE_NEAR, '100000000000001')]), ME)
    )
    refused(() =>
      assertRnearSafe(payload(RNEAR_CONTRACT, [stake(ONE_NEAR, '200000000000001')]), ME)
    )
  })
})
