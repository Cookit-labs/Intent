import { bcs } from '@mysten/sui/bcs'
import { Transaction } from '@mysten/sui/transactions'
import { fromBase64, toBase64 } from '@mysten/sui/utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CAPTURED_CETUS_TO_SUI,
  CAPTURED_CETUS_TO_USDSUI,
  CAPTURED_NAVI_DEPOSIT,
  CAPTURED_SENDER,
  CAPTURED_SPRINGSUI_STAKE,
} from '../chains/sui/captured-transactions'
import { CETUS_POLICY, NAVI_POLICY, SPRINGSUI_POLICY } from '../chains/sui/policies'
import { assertPtbSafe, type PtbPolicy } from '../chains/sui/safety'
import { ChainActionRefused } from '../chains/types'

const ME = CAPTURED_SENDER
const THIEF = '0x000000000000000000000000000000000000000000000000000000000000dead'
const FOREIGN = '0x00000000000000000000000000000000000000000000000000000000000bad01'
const CETUS_ROUTER = '0xffd4058af7d6f6d66c335930cced8c91e38ec943e2392232aee27e8127e684e9'
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'

function check(transaction: string, policy: PtbPolicy, account: string = ME): void {
  assertPtbSafe({ family: 'sui', transaction }, account, policy)
}

async function edited(base: string, edit: (tx: Transaction) => void): Promise<string> {
  const tx = Transaction.from(base)
  edit(tx)
  return toBase64(await tx.build())
}

interface JsonCommand {
  MoveCall?: { function: string; arguments: { Input?: number }[] }
}
interface JsonTx {
  inputs: { Pure?: { bytes: string } }[]
  commands: JsonCommand[]
}

/** Rewrites one pure argument of `new_swap_context_v3` in a captured swap. */
async function withSwapArgument(base: string, index: number, bytes: Uint8Array): Promise<string> {
  const data = JSON.parse(await Transaction.from(base).toJSON()) as JsonTx
  const call = data.commands.find((c) => c.MoveCall?.function === 'new_swap_context_v3')
  const input = call?.MoveCall?.arguments[index]?.Input
  const target = input === undefined ? undefined : data.inputs[input]
  if (target?.Pure === undefined) throw new Error('no such pure argument')
  target.Pure.bytes = toBase64(bytes)
  return toBase64(await Transaction.from(JSON.stringify(data)).build())
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('what the venues really built passes', () => {
  it.each([
    ['a swap into SUI', CAPTURED_CETUS_TO_SUI, CETUS_POLICY],
    ['a swap into USDsui', CAPTURED_CETUS_TO_USDSUI, CETUS_POLICY],
    ['a NAVI deposit', CAPTURED_NAVI_DEPOSIT, NAVI_POLICY],
    ['a SpringSui stake', CAPTURED_SPRINGSUI_STAKE, SPRINGSUI_POLICY],
  ])('%s', (_name, transaction, policy) => {
    expect(() => check(transaction, policy)).not.toThrow()
  })

  it('accepts a differently cased, unpadded form of the account', () => {
    expect(() =>
      check(CAPTURED_NAVI_DEPOSIT, NAVI_POLICY, ME.toUpperCase().replace('0X', '0x'))
    ).not.toThrow()
  })
})

describe('the signer', () => {
  it('refuses a transaction sent by someone else', async () => {
    const tampered = await edited(CAPTURED_CETUS_TO_SUI, (tx) => tx.setSender(THIEF))
    expect(() => check(tampered, CETUS_POLICY)).toThrow(ChainActionRefused)
    expect(() => check(tampered, CETUS_POLICY)).toThrow(/different account/)
  })

  it('refuses a captured transaction checked against a different account', () => {
    expect(() => check(CAPTURED_NAVI_DEPOSIT, NAVI_POLICY, THIEF)).toThrow(ChainActionRefused)
  })

  it('refuses an account that is not a Sui address', () => {
    expect(() =>
      check(
        CAPTURED_NAVI_DEPOSIT,
        NAVI_POLICY,
        'GAJ74DIC3252BKBTDCEYTDA2ZYDRDBDT3QMZU5IW2HOZQBYVXMRZZEFA'
      )
    ).toThrow(/Sui address/)
  })

  it('refuses gas paid by someone else', async () => {
    const tampered = await edited(CAPTURED_NAVI_DEPOSIT, (tx) => tx.setGasOwner(THIEF))
    expect(() => check(tampered, NAVI_POLICY)).toThrow(/network fee/)
  })
})

describe('contracts', () => {
  it('refuses a package outside the allowlist', async () => {
    const tampered = await edited(CAPTURED_CETUS_TO_SUI, (tx) => {
      tx.moveCall({ target: `${FOREIGN}::drain::everything` })
    })
    expect(() => check(tampered, CETUS_POLICY)).toThrow(ChainActionRefused)
    expect(() => check(tampered, CETUS_POLICY)).toThrow(/confirmed/)
  })

  it("refuses one venue's contract in another venue's transaction", () => {
    expect(() => check(CAPTURED_NAVI_DEPOSIT, CETUS_POLICY)).toThrow(/confirmed/)
    expect(() => check(CAPTURED_CETUS_TO_SUI, NAVI_POLICY)).toThrow(/confirmed/)
  })

  it('fails closed on a new package id, which is what a protocol upgrade looks like', async () => {
    const data = JSON.parse(await Transaction.from(CAPTURED_NAVI_DEPOSIT).toJSON()) as JsonTx
    const upgraded = JSON.stringify(data).replaceAll(
      '0x512f28261c1a293f49416d8885b8d5d32bde6dd68a99a0be36fe42b248e6833a',
      FOREIGN
    )
    const transaction = toBase64(await Transaction.from(upgraded).build())
    expect(() => check(transaction, NAVI_POLICY)).toThrow(/upgraded/)
  })

  it('refuses a function the venue has but this flow never needs', async () => {
    const tampered = await edited(CAPTURED_CETUS_TO_SUI, (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [BigInt(1)])
      tx.moveCall({
        target: `${CETUS_ROUTER}::router::transfer_balance`,
        typeArguments: ['0x2::sui::SUI'],
        arguments: [coin as never, tx.pure.address(THIEF)],
      })
    })
    expect(() => check(tampered, CETUS_POLICY)).toThrow(/confirmed/)
  })

  it('refuses the framework transfer calls, which would bypass the transfer check', async () => {
    for (const target of ['0x2::transfer::public_transfer', '0x2::pay::split_and_transfer']) {
      const tampered = await edited(CAPTURED_NAVI_DEPOSIT, (tx) => {
        const [coin] = tx.splitCoins(tx.gas, [BigInt(1)])
        tx.moveCall({
          target,
          typeArguments: ['0x2::coin::Coin<0x2::sui::SUI>'],
          arguments: [coin as never, tx.pure.address(THIEF)],
        })
      })
      expect(() => check(tampered, NAVI_POLICY)).toThrow(/confirmed/)
    }
  })

  it('refuses publishing or upgrading a package', async () => {
    const published = await edited(CAPTURED_NAVI_DEPOSIT, (tx) => {
      tx.publish({ modules: ['AA=='], dependencies: ['0x1', '0x2'] })
    })
    expect(() => check(published, NAVI_POLICY)).toThrow(/Publish/)
  })
})

describe('where things are sent', () => {
  it('allows a transfer back to the account', async () => {
    const fine = await edited(CAPTURED_NAVI_DEPOSIT, (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [BigInt(1)])
      tx.transferObjects([coin as never], ME)
    })
    expect(() => check(fine, NAVI_POLICY)).not.toThrow()
  })

  it('refuses a transfer to another address', async () => {
    const tampered = await edited(CAPTURED_CETUS_TO_SUI, (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [BigInt(1)])
      tx.transferObjects([coin as never], THIEF)
    })
    expect(() => check(tampered, CETUS_POLICY)).toThrow(ChainActionRefused)
    expect(() => check(tampered, CETUS_POLICY)).toThrow(/another address/)
  })

  it('refuses a transfer whose destination is computed, not stated', async () => {
    const tampered = await edited(CAPTURED_NAVI_DEPOSIT, (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [BigInt(1)])
      const [computed] = tx.splitCoins(tx.gas, [BigInt(2)])
      tx.transferObjects([coin as never], computed as never)
    })
    expect(() => check(tampered, NAVI_POLICY)).toThrow(/another address/)
  })

  it('checks every transfer, not only the first', async () => {
    const tampered = await edited(CAPTURED_NAVI_DEPOSIT, (tx) => {
      const [first, second] = tx.splitCoins(tx.gas, [BigInt(1), BigInt(2)])
      tx.transferObjects([first as never], ME)
      tx.transferObjects([second as never], THIEF)
    })
    expect(() => check(tampered, NAVI_POLICY)).toThrow(/another address/)
  })

  it('refuses address-balance funds sent to another address', async () => {
    const tampered = await edited(CAPTURED_NAVI_DEPOSIT, (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [BigInt(1)])
      tx.moveCall({
        target: '0x2::coin::send_funds',
        typeArguments: ['0x2::sui::SUI'],
        arguments: [coin as never, tx.pure.address(THIEF)],
      })
    })
    expect(() => check(tampered, NAVI_POLICY)).toThrow(/another address/)
  })

  it('allows address-balance funds returned to the account', async () => {
    const fine = await edited(CAPTURED_NAVI_DEPOSIT, (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [BigInt(1)])
      tx.moveCall({
        target: '0x2::coin::send_funds',
        typeArguments: ['0x2::sui::SUI'],
        arguments: [coin as never, tx.pure.address(ME)],
      })
    })
    expect(() => check(fine, NAVI_POLICY)).not.toThrow()
  })
})

describe('the arguments of a Cetus swap', () => {
  const u32 = (n: number): Uint8Array => bcs.u32().serialize(n).toBytes()
  const u64 = (n: number): Uint8Array => bcs.u64().serialize(n).toBytes()
  const address = (a: string): Uint8Array => bcs.Address.serialize(a).toBytes()

  it('refuses slippage over 100 bps', async () => {
    const tampered = await withSwapArgument(CAPTURED_CETUS_TO_SUI, 4, u64(10_001))
    expect(() => check(tampered, CETUS_POLICY)).toThrow(/slippage/i)
  })

  it('allows slippage of exactly 100 bps', async () => {
    const fine = await withSwapArgument(CAPTURED_CETUS_TO_SUI, 4, u64(10_000))
    expect(() => check(fine, CETUS_POLICY)).not.toThrow()
  })

  it('refuses a fee when no fee is configured', async () => {
    const tampered = await withSwapArgument(CAPTURED_CETUS_TO_SUI, 6, u32(100_000))
    expect(() => check(tampered, CETUS_POLICY)).toThrow(/fee/)
  })

  it('refuses a configured fee rate paid to the wrong address', async () => {
    vi.stubEnv('CETUS_OVERLAY_FEE_RECEIVER', ME)
    vi.stubEnv('CETUS_OVERLAY_FEE_BPS', '10')
    const rated = await withSwapArgument(CAPTURED_CETUS_TO_SUI, 6, u32(1_000))
    const tampered = await withSwapArgument(rated, 7, address(THIEF))
    expect(() => check(tampered, CETUS_POLICY)).toThrow(/fee/)
  })

  it('refuses a fee above the configured rate', async () => {
    vi.stubEnv('CETUS_OVERLAY_FEE_RECEIVER', ME)
    vi.stubEnv('CETUS_OVERLAY_FEE_BPS', '10')
    const rated = await withSwapArgument(CAPTURED_CETUS_TO_SUI, 6, u32(1_001))
    const tampered = await withSwapArgument(rated, 7, address(ME))
    expect(() => check(tampered, CETUS_POLICY)).toThrow(/fee/)
  })

  it('allows exactly the configured fee to the configured receiver', async () => {
    vi.stubEnv('CETUS_OVERLAY_FEE_RECEIVER', ME)
    vi.stubEnv('CETUS_OVERLAY_FEE_BPS', '10')
    const rated = await withSwapArgument(CAPTURED_CETUS_TO_SUI, 6, u32(1_000))
    const fine = await withSwapArgument(rated, 7, address(ME))
    expect(() => check(fine, CETUS_POLICY)).not.toThrow()
  })

  it('refuses a swap whose output is a coin outside the token list', async () => {
    const data = JSON.parse(await Transaction.from(CAPTURED_CETUS_TO_USDSUI).toJSON()) as JsonTx
    const scam = JSON.stringify(data).replaceAll(
      '0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI',
      '0x778e2ae6096389cfad3e0b1c6e8080a9287f8792a08d3df1f9025251d820be93::usdt::USDT'
    )
    const tampered = toBase64(await Transaction.from(scam).build())
    expect(() => check(tampered, CETUS_POLICY)).toThrow(/token/)
  })
})

describe('the coin a SpringSui stake mints', () => {
  it('refuses a stake into a liquid staking token other than sSUI', async () => {
    const data = JSON.parse(await Transaction.from(CAPTURED_SPRINGSUI_STAKE).toJSON()) as JsonTx
    const scam = JSON.stringify(data).replaceAll(
      '0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI',
      '0x460c669acd3f294dc4247a6877ec2532340ffde76162ab201e72fe95355830e7::asui::ASUI'
    )
    const tampered = toBase64(await Transaction.from(scam).build())
    expect(() => check(tampered, SPRINGSUI_POLICY)).toThrow(/sSUI/)
  })

  it('refuses the minted coin sent to someone else', async () => {
    const data = JSON.parse(await Transaction.from(CAPTURED_SPRINGSUI_STAKE).toJSON()) as JsonTx
    const me = toBase64(bcs.Address.serialize(ME).toBytes())
    const thief = toBase64(bcs.Address.serialize(THIEF).toBytes())
    const tampered = toBase64(
      await Transaction.from(JSON.stringify(data).replaceAll(me, thief)).build()
    )
    expect(() => check(tampered, SPRINGSUI_POLICY)).toThrow(/another address/)
  })
})

describe('payloads that are not a transaction', () => {
  it.each([
    ['garbage', 'not base64 at all!'],
    ['an empty string', ''],
    ['truncated bytes', CAPTURED_NAVI_DEPOSIT.slice(0, 40)],
    ['the JSON form', '{"version":2,"commands":[]}'],
  ])('refuses %s with a readable reason', (_name, transaction) => {
    expect(() => check(transaction, NAVI_POLICY)).toThrow(ChainActionRefused)
  })

  it('refuses a payload for another chain', () => {
    expect(() =>
      assertPtbSafe({ family: 'solana', transaction: CAPTURED_NAVI_DEPOSIT }, ME, NAVI_POLICY)
    ).toThrow(ChainActionRefused)
  })

  it('refuses address-balance funds withdrawn from anyone but the sender', () => {
    // A transaction with a sponsor withdrawal cannot be built by this app, so it is written directly.
    const tx = Transaction.from(CAPTURED_NAVI_DEPOSIT)
    const data = tx.getData() as unknown as { inputs: unknown[] }
    expect(data.inputs.length).toBeGreaterThan(0)
    const json = {
      ...(JSON.parse(
        JSON.stringify(data, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))
      ) as object),
    } as { inputs: unknown[] }
    json.inputs.push({
      $kind: 'FundsWithdrawal',
      FundsWithdrawal: {
        reservation: { $kind: 'MaxAmountU64', MaxAmountU64: '1' },
        typeArg: { $kind: 'Balance', Balance: USDC },
        withdrawFrom: { $kind: 'Sponsor', Sponsor: true },
      },
    })
    const bytes = Transaction.from(JSON.stringify(json)).build()
    return bytes.then((built) => {
      expect(fromBase64(toBase64(built)).length).toBeGreaterThan(0)
      expect(() => check(toBase64(built), NAVI_POLICY)).toThrow(/sender/)
    })
  })
})
