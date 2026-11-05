import { describe, expect, it } from 'vitest'

import { associatedTokenAccount, decodeSolanaTransaction } from '../chains/solana/assert-safe'
import {
  createMarinadeVenue,
  decodeMarinadeState,
  liquidUnstake,
  MARINADE_PROGRAM,
  MARINADE_STATE,
  MARINADE_TOKENS,
  MSOL_MINT,
} from '../chains/solana/marinade'
import { marinadeListing } from '../chains/solana/marinade-listing'
import { readU64 } from '../chains/solana/stake-pool'
import type { PreparedAction } from '../chains/types'
import {
  addressBytes,
  fakeRpc,
  ME,
  payload,
  rebuilt,
  SOMEONE_ELSE,
  transferOf,
  u32Bytes,
  u64Bytes,
  UNKNOWN_PROGRAM,
  unlimitedApproval,
  withAccount,
  withExtraData,
  withOtherFunction,
} from './solana-stake-fixtures'

const SOL_LEG = 'UefNb6z6yvArqe4cJHTXCqStRsKmWhGxnZzuHbikP5Q'
const MSOL_LEG = '7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE'
const TREASURY = 'B1aLzaNMeFVAyQ6f3XbbUyKcH2YPHu2fqiEagmiF23VR'

interface StateFixture {
  mint?: string
  msolLeg?: string
  active?: bigint
  reserve?: bigint
  tickets?: bigint
  supply?: bigint
  paused?: boolean
  maxFee?: number
  minFee?: number
  target?: bigint
  minDeposit?: bigint
  minWithdraw?: bigint
  cap?: bigint
}

/** Marinade's `State` at its Borsh offsets, with zeros where this code reads nothing. */
function encodeState(f: StateFixture = {}): Uint8Array {
  const data = new Uint8Array(647)
  const put = (at: number, bytes: number[]): void => data.set(bytes, at)
  put(8, addressBytes(f.mint ?? MSOL_MINT))
  put(104, addressBytes(TREASURY))
  put(138, u64Bytes(BigInt(2039280)))
  put(376, u64Bytes(f.active ?? BigInt('2233647963872566')))
  put(420, addressBytes(f.msolLeg ?? MSOL_LEG))
  put(452, u64Bytes(f.target ?? BigInt('3500000000000')))
  put(460, u32Bytes(f.maxFee ?? 150))
  put(464, u32Bytes(f.minFee ?? 3))
  put(496, u64Bytes(f.reserve ?? BigInt('23619572140625')))
  put(504, u64Bytes(f.supply ?? BigInt('1593220460250312')))
  put(528, u64Bytes(f.tickets ?? BigInt('1050140472887')))
  put(544, u64Bytes(f.minDeposit ?? BigInt(1)))
  put(552, u64Bytes(f.minWithdraw ?? BigInt(1)))
  put(560, u64Bytes(f.cap ?? BigInt('18446744073709551615')))
  data[608] = f.paused === true ? 1 : 0
  put(609, u32Bytes(2000))
  data[638] = 2
  return data
}

function venueWith(state: StateFixture = {}, solLeg = BigInt('116426934088')) {
  const rpc = fakeRpc({
    epoch: 1077,
    accounts: {
      [MARINADE_STATE]: { owner: MARINADE_PROGRAM, lamports: BigInt(1), data: encodeState(state) },
      [SOL_LEG]: {
        owner: '11111111111111111111111111111111',
        lamports: solLeg,
        data: new Uint8Array(0),
      },
    },
  })
  return { venue: createMarinadeVenue({ rpc }), rpc }
}

const stake = { kind: 'stake', amount: '1', tokenIn: 'SOL' } as const
const unstake = { kind: 'unstake', amount: '1', tokenIn: 'mSOL' } as const

const preparedStake = (): Promise<PreparedAction> => venueWith().venue.prepare(stake, ME)
const preparedUnstake = (): Promise<PreparedAction> => venueWith().venue.prepare(unstake, ME)

function refuses(action: () => unknown, pattern: RegExp): void {
  expect(action).toThrow(pattern)
}

describe('marinade stake', () => {
  it('reads the amount from the state, with no rate invented', async () => {
    const prepared = await preparedStake()
    expect(prepared.receive?.symbol).toBe('mSOL')
    expect(Number(prepared.receive?.amount)).toBeCloseTo(0.70615, 4)
    expect(prepared.apy).toBeUndefined()
    expect(prepared.notes.join(' ')).toMatch(/not showing a yearly rate/)
    expect(prepared.notes.join(' ')).toMatch(/6-of-13/)
    expect(prepared.notes.join(' ')).toMatch(/3-of-5/)
    expect(prepared.notes.join(' ')).toMatch(/Neodyme, Ackee and Kudelski/)
  })

  it('deposits the amount asked, from the person, to their own mSOL account', async () => {
    const prepared = await preparedStake()
    if (prepared.signing.family !== 'solana') throw new Error('Expected Solana.')
    const decoded = decodeSolanaTransaction(prepared.signing.transaction)
    expect(decoded.feePayer).toBe(ME)
    expect(decoded.signerCount).toBe(1)
    const deposit = decoded.instructions.at(-1)!
    expect(decoded.staticAccounts[deposit.programIndex]).toBe(MARINADE_PROGRAM)
    expect(readU64(deposit.data, 8)).toBe(BigInt('1000000000'))
    expect(decoded.staticAccounts[deposit.accounts[6]!]).toBe(ME)
    expect(decoded.staticAccounts[deposit.accounts[7]!]).toBe(associatedTokenAccount(ME, MSOL_MINT))
  })

  it('passes its own check, and a quote builds nothing', async () => {
    const { venue, rpc } = venueWith()
    const prepared = await venue.prepare(stake, ME)
    expect(() => venue.assertSafe(prepared.signing, ME)).not.toThrow()
    const quoting = venueWith()
    const quoted = await quoting.venue.quote?.(stake, ME)
    expect(quoted?.receive?.symbol).toBe('mSOL')
    expect(quoted?.apyPercent).toBeUndefined()
    expect(quoting.rpc.calls).not.toContain('getLatestBlockhash')
    expect(rpc.calls).toContain('getLatestBlockhash')
  })

  it('refuses another token, when paused, over the cap, under the minimum', async () => {
    await expect(venueWith().venue.prepare({ ...stake, tokenIn: 'USDC' }, ME)).rejects.toThrow(
      /takes SOL/
    )
    await expect(venueWith({ paused: true }).venue.prepare(stake, ME)).rejects.toThrow(/paused/)
    await expect(venueWith({ cap: BigInt(1) }).venue.prepare(stake, ME)).rejects.toThrow(
      /cap is full/
    )
    await expect(
      venueWith({ minDeposit: BigInt('2000000000') }).venue.prepare(stake, ME)
    ).rejects.toThrow(/at least 2 SOL/)
  })

  it('refuses a state with another mint or another pool leg', async () => {
    await expect(
      venueWith({ mint: 'So11111111111111111111111111111111111111112' }).venue.prepare(stake, ME)
    ).rejects.toThrow(/doesn’t look as expected/)
    await expect(venueWith({ msolLeg: SOMEONE_ELSE }).venue.prepare(stake, ME)).rejects.toThrow(
      /doesn’t look as expected/
    )
  })
})

describe('marinade unstake', () => {
  it('calls it a sale into the pool, and names the fee and its ceiling', async () => {
    const prepared = await preparedUnstake()
    expect(prepared.kind).toBe('unstake')
    expect(prepared.pay).toEqual({ amount: '1', symbol: 'mSOL' })
    expect(prepared.receive?.symbol).toBe('SOL')
    const notes = prepared.notes.join(' ')
    expect(notes).toMatch(/sale into Marinade’s SOL pool/)
    expect(notes).toMatch(/takes no minimum/)
    expect(notes).toMatch(/1\.5% maximum/)
    expect(notes).toMatch(/delayed unstake charges 0\.2%/)
  })

  it('computes the fee as the program does, falling as the pool fills', () => {
    const state = decodeMarinadeState(encodeState())!
    const msol = BigInt('1000000000')
    const thin = liquidUnstake(state, msol, BigInt('116426934088'))
    expect(thin.feeBp).toBe(BigInt(146))
    const full = liquidUnstake(state, msol, BigInt('5000000000000'))
    expect(full.feeBp).toBe(BigInt(3))
    const drained = liquidUnstake(state, msol, BigInt(2039280))
    expect(drained.feeBp).toBe(BigInt(150))
    expect(full.lamports).toBeGreaterThan(thin.lamports)
  })

  it('refuses more than the pool holds, and a fee over the ceiling', async () => {
    await expect(
      venueWith({}, BigInt(1_000_000_000)).venue.prepare({ ...unstake, amount: '5' }, ME)
    ).rejects.toThrow(/doesn’t hold enough SOL/)
    await expect(venueWith({ maxFee: 500 }).venue.prepare(unstake, ME)).rejects.toThrow(/too high/)
  })

  it('refuses a token that is not mSOL', async () => {
    await expect(venueWith().venue.prepare({ ...unstake, tokenIn: 'SOL' }, ME)).rejects.toThrow(
      /takes mSOL/
    )
  })
})

describe('marinade unstake of everything', () => {
  it('sells exactly the balance read, so nothing is left behind, and pays only the person', async () => {
    const prepared = await venueWith().venue.prepare(
      { ...unstake, amount: '4.410107252', wholePosition: true },
      ME
    )
    if (prepared.signing.family !== 'solana') throw new Error('Expected Solana.')
    const decoded = decodeSolanaTransaction(prepared.signing.transaction)
    const sale = decoded.instructions.at(-1)!
    expect(readU64(sale.data, 8)).toBe(BigInt('4410107252'))
    expect(decoded.staticAccounts[sale.accounts[7]!]).toBe(ME)
    expect(() => venueWith().venue.assertSafe(prepared.signing, ME)).not.toThrow()
  })
})

describe('marinade assertSafe', () => {
  const venue = venueWith().venue

  it('refuses the wrong signer', async () => {
    const prepared = await preparedStake()
    refuses(() => venue.assertSafe(prepared.signing, SOMEONE_ELSE), /network fee/)
    refuses(() => venue.assertSafe(payload(SOMEONE_ELSE, rebuilt(prepared, ME)), ME), /network fee/)
  })

  it('refuses an unknown program', async () => {
    const rest = rebuilt(await preparedStake(), ME)
    const last = rest.at(-1)!
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [
            ...rest.slice(0, -1),
            { ...last, programAddress: UNKNOWN_PROGRAM as never },
          ]),
          ME
        ),
      /should not need/
    )
  })

  it('refuses an unknown function', async () => {
    const rest = rebuilt(await preparedStake(), ME)
    refuses(
      () =>
        venue.assertSafe(payload(ME, [...rest.slice(0, -1), withOtherFunction(rest.at(-1)!)]), ME),
      /didn’t expect/
    )
  })

  it('refuses extra calldata', async () => {
    const rest = rebuilt(await preparedUnstake(), ME)
    refuses(
      () => venue.assertSafe(payload(ME, [...rest.slice(0, -1), withExtraData(rest.at(-1)!)]), ME),
      /didn’t expect/
    )
  })

  it('refuses mSOL going to someone else', async () => {
    const rest = rebuilt(await preparedStake(), ME)
    const theirs = associatedTokenAccount(SOMEONE_ELSE, MSOL_MINT)
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [...rest.slice(0, -1), withAccount(rest.at(-1)!, 7, theirs)]),
          ME
        ),
      /isn’t what Marinade should get/
    )
  })

  it('refuses unstaked SOL going to someone else', async () => {
    const rest = rebuilt(await preparedUnstake(), ME)
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [...rest.slice(0, -1), withAccount(rest.at(-1)!, 7, SOMEONE_ELSE)]),
          ME
        ),
      /isn’t what Marinade should get/
    )
  })

  it('refuses a transfer or an unlimited approval added to it', async () => {
    const rest = rebuilt(await preparedUnstake(), ME)
    refuses(
      () => venue.assertSafe(payload(ME, [...rest, transferOf(ME, SOMEONE_ELSE, BigInt(1))]), ME),
      /SOL transfer/
    )
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [
            ...rest,
            unlimitedApproval(associatedTokenAccount(ME, MSOL_MINT), SOMEONE_ELSE, ME),
          ]),
          ME
        ),
      /moves or approves tokens/
    )
  })

  it('refuses the wrong token and the wrong state', async () => {
    const rest = rebuilt(await preparedStake(), ME)
    const last = rest.at(-1)!
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [
            ...rest.slice(0, -1),
            withAccount(last, 1, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
          ]),
          ME
        ),
      /isn’t what Marinade should get/
    )
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [...rest.slice(0, -1), withAccount(last, 0, SOMEONE_ELSE)]),
          ME
        ),
      /isn’t what Marinade should get/
    )
  })

  it('refuses an amount of zero', async () => {
    const rest = rebuilt(await preparedStake(), ME)
    const last = rest.at(-1)!
    const data = Uint8Array.from(last.data ?? [])
    data.fill(0, 8)
    refuses(
      () => venue.assertSafe(payload(ME, [...rest.slice(0, -1), { ...last, data }]), ME),
      /isn’t what Marinade should get/
    )
  })
})

describe('marinade tokens and listing', () => {
  it('names mSOL with its mint and decimals', () => {
    expect(MARINADE_TOKENS).toEqual([
      { symbol: 'mSOL', id: MSOL_MINT, decimals: 9, name: 'Marinade staked SOL' },
    ])
  })

  it('lists as executing on Solana', () => {
    expect(marinadeListing).toMatchObject({
      id: 'marinade',
      family: 'solana',
      integration: 'executes',
    })
    expect(marinadeListing.capability).toMatch(/Native staking and delayed unstake aren’t wired/)
  })
})
