import { describe, expect, it } from 'vitest'

import { TOKEN_PROGRAM, associatedTokenAccount } from '../chains/solana/assert-safe'
import {
  assertKaminoLendSafe,
  KAMINO_LEND_RESERVES,
  KAMINO_MAIN_MARKET,
  KLEND_PROGRAM,
  obligationAddress,
  reserveListing,
  U64_MAX,
  userMetadataAddress,
} from '../chains/solana/kamino-lend-rules'
import { createKaminoLendVenue } from '../chains/solana/kamino-lend'
import { kaminoLendListing } from '../chains/solana/kamino-lend-listing'
import { KFARMS_PROGRAM } from '../chains/solana/programs'
import { readU64, type SolanaRpc } from '../chains/solana/stake-pool'
import { ownWrappedSolAccount } from '../chains/solana/assert-safe'
import { ChainActionRefused, type ChainActionRequest, type PreparedAction } from '../chains/types'
import {
  addressBytes,
  BLOCKHASH,
  budget,
  instructionsOf,
  ME,
  payload,
  rebuilt,
  SOMEONE_ELSE,
  transferOf,
  u64Bytes,
  UNKNOWN_PROGRAM,
  unlimitedApproval,
  withAccount,
  withExtraData,
  withOtherFunction,
} from './solana-stake-fixtures'

const SYSTEM = '11111111111111111111111111111111'
const USDC_RESERVE = reserveListing('USDC')
const SOL_RESERVE = reserveListing('SOL')
const JITOSOL_RESERVE = reserveListing('JitoSOL')
const OBLIGATION = obligationAddress(ME)
const FARM = 'JAvnB9AKtgPsTEoKmn24Bq64UMoYcrtWtq42HHBdsPkh'
const SCOPE = '3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH'
const SF = BigInt(1) << BigInt(60)
const TEN_POW_6 = BigInt(1_000_000)

const discriminator = {
  obligation: [0xa8, 0xce, 0x8d, 0x6a, 0x58, 0x4c, 0xac, 0xa7],
  reserve: [0x2b, 0xf2, 0xcc, 0xca, 0x1a, 0xf7, 0x3b, 0x7f],
}

interface ReserveFixture {
  reserve: string
  mint: string
  decimals: number
  /** Dollars per token, as a whole number of millionths. */
  priceMicros: bigint
  available: bigint
  borrowed: bigint
  cTokens: bigint
  ltv: number
  threshold: number
  borrowFactor?: bigint
  borrowLimit?: bigint
  status?: number
  farmCollateral?: string
  farmDebt?: string
  takeRate?: number
  hostFixedBps?: number
  originationSf?: bigint
  curve?: [number, number][]
  cumulative?: bigint
  tokenProgram?: string
  name?: string
}

function put(target: Uint8Array, at: number, bytes: readonly number[]): void {
  target.set(Uint8Array.from(bytes), at)
}

function u128(value: bigint): number[] {
  return Array.from({ length: 16 }, (_, i) => Number((value >> BigInt(8 * i)) & BigInt(255)))
}

function encodeReserve(fixture: ReserveFixture): Uint8Array {
  const data = new Uint8Array(8624)
  put(data, 0, discriminator.reserve)
  put(data, 8, u64Bytes(BigInt(1)))
  new DataView(data.buffer).setUint32(28, Math.floor(Date.now() / 1000), true)
  put(data, 32, addressBytes(KAMINO_MAIN_MARKET))
  put(data, 64, addressBytes(fixture.farmCollateral ?? SYSTEM))
  put(data, 96, addressBytes(fixture.farmDebt ?? SYSTEM))
  put(data, 128, addressBytes(fixture.mint))
  put(data, 160, addressBytes('Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6'))
  put(data, 192, addressBytes('BbDUrk1bVtSixgQsPLBJFZEF7mwGstnD5joA1WzYvYFX'))
  put(data, 224, u64Bytes(fixture.available))
  put(data, 232, u128(fixture.borrowed * SF))
  put(data, 248, u128((fixture.priceMicros * SF) / TEN_POW_6))
  put(data, 272, u64Bytes(BigInt(fixture.decimals)))
  put(data, 296, u128(fixture.cumulative ?? SF))
  put(data, 408, addressBytes(fixture.tokenProgram ?? TOKEN_PROGRAM))
  put(data, 2560, addressBytes('B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D'))
  put(data, 2592, u64Bytes(fixture.cTokens))
  put(data, 2600, addressBytes('3DzjXRfxRm6iejfyyMynR4tScddaanrePJ1NJU2XnPPL'))
  data[4856] = fixture.status ?? 0
  put(data, 4858, [fixture.hostFixedBps ?? 0, 0])
  data[4870] = fixture.takeRate ?? 10
  data[4872] = fixture.ltv
  data[4873] = fixture.threshold
  put(data, 4874, [100, 0])
  put(data, 4876, [0xe8, 0x03])
  put(data, 4896, u64Bytes(fixture.originationSf ?? BigInt(0)))
  const curve = fixture.curve ?? [
    [0, 0],
    [10000, 1000],
  ]
  curve.forEach(([utilization, rate], i) => {
    put(data, 4920 + i * 8, [
      utilization & 255,
      utilization >> 8,
      0,
      0,
      rate & 255,
      rate >> 8,
      0,
      0,
    ])
  })
  put(data, 5008, u64Bytes(fixture.borrowFactor ?? BigInt(100)))
  put(data, 5024, u64Bytes(fixture.borrowLimit ?? BigInt('100000000000000000')))
  const name = new TextEncoder().encode(fixture.name ?? 'TOKEN')
  data.set(name, 5032)
  put(data, 5112, addressBytes(SCOPE))
  put(data, 5160, addressBytes(SYSTEM))
  put(data, 5192, addressBytes(SYSTEM))
  put(data, 5224, addressBytes(SYSTEM))
  return data
}

interface ObligationFixture {
  owner?: string
  deposits?: { reserve: string; cTokens: bigint }[]
  borrows?: { reserve: string; amount: bigint; cumulative?: bigint }[]
  elevationGroup?: number
  referrer?: string
}

function encodeObligation(fixture: ObligationFixture): Uint8Array {
  const data = new Uint8Array(3344)
  put(data, 0, discriminator.obligation)
  put(data, 32, addressBytes(KAMINO_MAIN_MARKET))
  put(data, 64, addressBytes(fixture.owner ?? ME))
  ;(fixture.deposits ?? []).forEach(({ reserve, cTokens }, i) => {
    put(data, 96 + i * 136, addressBytes(reserve))
    put(data, 96 + i * 136 + 32, u64Bytes(cTokens))
  })
  ;(fixture.borrows ?? []).forEach(({ reserve, amount, cumulative }, i) => {
    put(data, 1208 + i * 200, addressBytes(reserve))
    put(data, 1208 + i * 200 + 32, u128(cumulative ?? SF))
    put(data, 1208 + i * 200 + 88, u128(amount * SF))
  })
  data[2285] = fixture.elevationGroup ?? 0
  put(data, 2288, addressBytes(fixture.referrer ?? SYSTEM))
  return data
}

const USDC: ReserveFixture = {
  reserve: USDC_RESERVE.reserve,
  mint: USDC_RESERVE.mint,
  decimals: 6,
  priceMicros: TEN_POW_6,
  available: BigInt(1_000_000_000_000),
  borrowed: BigInt(1_000_000_000_000),
  cTokens: BigInt(1_000_000_000_000),
  ltv: 80,
  threshold: 90,
  farmCollateral: FARM,
  hostFixedBps: 50,
}

const JITOSOL: ReserveFixture = {
  reserve: JITOSOL_RESERVE.reserve,
  mint: JITOSOL_RESERVE.mint,
  decimals: 9,
  priceMicros: BigInt(100_000_000),
  available: BigInt('1000000000000000'),
  borrowed: BigInt(0),
  cTokens: BigInt('1000000000000000'),
  ltv: 50,
  threshold: 60,
  borrowLimit: BigInt(0),
}

const SOL: ReserveFixture = {
  reserve: SOL_RESERVE.reserve,
  mint: SOL_RESERVE.mint,
  decimals: 9,
  priceMicros: BigInt(100_000_000),
  available: BigInt('1000000000000000'),
  borrowed: BigInt('1000000000000000'),
  cTokens: BigInt('1000000000000000'),
  ltv: 70,
  threshold: 80,
  borrowFactor: BigInt(125),
  farmCollateral: 'So11111111111111111111111111111111111111112',
}

interface FakeChain {
  reserves?: ReserveFixture[]
  obligation?: ObligationFixture
  metadata?: boolean
  farmUserStates?: string[]
  simulation?: { err: unknown; logs: string[] }
  unreadable?: boolean
}

function chain(fake: FakeChain): SolanaRpc & { simulated: string[]; calls: string[] } {
  const simulated: string[] = []
  const calls: string[] = []
  const accounts = new Map<string, { owner: string; data: Uint8Array }>()
  for (const reserve of fake.reserves ?? [USDC, JITOSOL, SOL]) {
    accounts.set(reserve.reserve, { owner: KLEND_PROGRAM, data: encodeReserve(reserve) })
  }
  if (fake.obligation !== undefined) {
    accounts.set(OBLIGATION, { owner: KLEND_PROGRAM, data: encodeObligation(fake.obligation) })
  }
  if (fake.metadata === true) {
    accounts.set(userMetadataAddress(ME), { owner: KLEND_PROGRAM, data: new Uint8Array(1032) })
  }
  for (const state of fake.farmUserStates ?? []) {
    accounts.set(state, { owner: KFARMS_PROGRAM, data: new Uint8Array(920) })
  }
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    calls.push(method)
    if (fake.unreadable === true) throw new ChainActionRefused('Solana could not be read.')
    switch (method) {
      case 'getMultipleAccounts':
        return {
          value: (params[0] as string[]).map((address) => {
            const account = accounts.get(address)
            return account === undefined
              ? null
              : {
                  owner: account.owner,
                  lamports: 1,
                  data: [Buffer.from(account.data).toString('base64'), 'base64'],
                }
          }),
        }
      case 'getLatestBlockhash':
        return { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1 } }
      case 'simulateTransaction':
        simulated.push(params[0] as string)
        return { value: fake.simulation ?? { err: null, logs: [] } }
      default:
        throw new Error(`This test must not call ${method}.`)
    }
  }
  return Object.assign(rpc, { simulated, calls })
}

const ask = (
  kind: ChainActionRequest['kind'],
  amount: string,
  tokenIn: string,
  extra: Partial<ChainActionRequest> = {}
): ChainActionRequest => ({ kind, amount, tokenIn, ...extra })

const prepareOn = (fake: FakeChain, request: ChainActionRequest): Promise<PreparedAction> =>
  createKaminoLendVenue({ rpc: chain(fake) }).prepare(request, ME)

/** Pulls apart what was built: each step by name, as the program's own discriminators say. */
const NAMES: Record<string, string> = {
  '75a9b045c5170fa2': 'init_user_metadata',
  fb0ae74c1b0b9f60: 'init_obligation',
  '883f0fbad398a8a4': 'init_obligation_farms',
  '02da8aeb4fc91966': 'refresh_reserve',
  '218493e497c04859': 'refresh_obligation',
  d8e0bf1bcc9766af: 'deposit',
  eb34779895c51407: 'withdraw',
  a1808ff5abc7c206: 'borrow',
  '74aed54cb435d290': 'repay',
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function steps(prepared: PreparedAction): string[] {
  return instructionsOf(prepared)
    .filter((i) => !i.programAddress.startsWith('ComputeBudget'))
    .map((i) => {
      const data = i.data ?? new Uint8Array()
      if (i.programAddress === KLEND_PROGRAM) return NAMES[hex(data.subarray(0, 8))] ?? 'unknown'
      if (i.programAddress === SYSTEM) return 'wrap'
      if (i.programAddress === TOKEN_PROGRAM) return data[0] === 17 ? 'sync' : 'close'
      return 'create_token_account'
    })
}

function action(prepared: PreparedAction, name: string) {
  const found = instructionsOf(prepared).find(
    (i) =>
      i.programAddress === KLEND_PROGRAM &&
      NAMES[hex((i.data ?? []).slice(0, 8) as Uint8Array)] === name
  )
  if (found === undefined) throw new Error(`No ${name} step.`)
  return found
}

const addressAt = (instruction: ReturnType<typeof action>, position: number): string =>
  instruction.accounts?.[position]?.address as string
const amountOf = (instruction: ReturnType<typeof action>): bigint =>
  readU64(instruction.data as Uint8Array, 8)

const HOLDING: FakeChain = {
  metadata: true,
  obligation: { deposits: [{ reserve: USDC.reserve, cTokens: BigInt(1_000_000_000) }] },
  farmUserStates: [],
}

describe('the pins', () => {
  it('lists its own reserves against the mints the chain table uses', () => {
    expect(KAMINO_LEND_RESERVES.map((r) => r.symbol)).toEqual([
      'SOL',
      'USDC',
      'USDT',
      'JitoSOL',
      'mSOL',
    ])
  })

  it('is listed as its own app, apart from Kamino Earn', () => {
    expect(kaminoLendListing).toMatchObject({ id: 'kamino-lend', integration: 'executes' })
    expect(createKaminoLendVenue({ rpc: chain({}) }).name).toBe('Kamino Lend')
    expect(createKaminoLendVenue({ rpc: chain({}) }).kinds).toEqual([
      'supply',
      'withdraw',
      'borrow',
      'repay',
    ])
  })
})

describe('supply', () => {
  it('opens the position on a first deposit and sends the right amount from the person’s account', async () => {
    const prepared = await prepareOn({}, ask('supply', '12.5', 'USDC'))
    expect(steps(prepared)).toEqual([
      'init_user_metadata',
      'init_obligation',
      'init_obligation_farms',
      'refresh_reserve',
      'refresh_obligation',
      'deposit',
    ])
    const deposit = action(prepared, 'deposit')
    expect(amountOf(deposit)).toBe(BigInt(12_500_000))
    expect(addressAt(deposit, 0)).toBe(ME)
    expect(addressAt(deposit, 1)).toBe(OBLIGATION)
    expect(addressAt(deposit, 4)).toBe(USDC.reserve)
    expect(addressAt(deposit, 9)).toBe(associatedTokenAccount(ME, USDC.mint))
    expect(() => assertKaminoLendSafe(prepared.signing, ME)).not.toThrow()
  })

  it('skips the setup once the position exists', async () => {
    const prepared = await prepareOn(HOLDING, ask('supply', '1', 'JitoSOL'))
    expect(steps(prepared)).toEqual([
      'refresh_reserve',
      'refresh_reserve',
      'refresh_obligation',
      'deposit',
    ])
  })

  it('wraps SOL first, and returns what is left in the wrapped account', async () => {
    const prepared = await prepareOn(HOLDING, ask('supply', '1', 'SOL'))
    expect(steps(prepared)).toEqual([
      'create_token_account',
      'wrap',
      'sync',
      'init_obligation_farms',
      'refresh_reserve',
      'refresh_reserve',
      'refresh_obligation',
      'deposit',
      'close',
    ])
    expect(() => assertKaminoLendSafe(prepared.signing, ME)).not.toThrow()
  })

  it('says plainly this backs a loan, and that Kamino Earn does not', async () => {
    const prepared = await prepareOn({}, ask('supply', '1', 'USDC'))
    const text = prepared.notes.join(' ')
    expect(prepared.venueName).toBe('Kamino Lend')
    expect(text).toMatch(/Kamino Earn/)
    expect(text).toMatch(/can back a loan/i)
    expect(text).toMatch(/80%/)
  })

  it('fits the widest first deposit in one transaction', async () => {
    const prepared = await prepareOn({}, ask('supply', '1', 'SOL'))
    expect(steps(prepared)).toEqual([
      'create_token_account',
      'wrap',
      'sync',
      'init_user_metadata',
      'init_obligation',
      'init_obligation_farms',
      'refresh_reserve',
      'refresh_obligation',
      'deposit',
      'close',
    ])
    expect(() => assertKaminoLendSafe(prepared.signing, ME)).not.toThrow()
  })

  it('states what the first deposit costs in rent', async () => {
    const prepared = await prepareOn({}, ask('supply', '1', 'USDC'))
    expect(prepared.notes.join(' ')).toMatch(/0\.03\d* SOL/)
  })

  it('reads the rate from the reserve’s own curve', async () => {
    const prepared = await prepareOn({}, ask('supply', '1', 'USDC'))
    // Half lent, and the curve is 0% to 10% over all use: 5% to borrowers, of which savers get half less 10%.
    expect(prepared.apy?.basePercent).toBeCloseTo((Math.exp(0.05 * 0.5 * 0.9) - 1) * 100, 1)
  })

  it('refuses a token it has no reserve for', async () => {
    await expect(prepareOn({}, ask('supply', '1', 'BONK'))).rejects.toThrow(/takes SOL, USDC/)
  })

  it('refuses a reserve no longer active', async () => {
    await expect(
      prepareOn({ reserves: [{ ...USDC, status: 1 }] }, ask('supply', '1', 'USDC'))
    ).rejects.toThrow(/isn’t taking/)
  })

  it('refuses a reserve that has moved to another token', async () => {
    await expect(
      prepareOn({ reserves: [{ ...USDC, mint: JITOSOL.mint }] }, ask('supply', '1', 'USDC'))
    ).rejects.toThrow(/doesn’t look as expected/)
  })
})

describe('borrow', () => {
  const COLLATERAL: FakeChain = {
    metadata: true,
    // Ten JitoSOL at $100: $1,000 of value, of which half can be borrowed against.
    obligation: { deposits: [{ reserve: JITOSOL.reserve, cTokens: BigInt(10_000_000_000) }] },
  }

  it('sends what is borrowed to the person’s own account and refreshes first', async () => {
    const prepared = await prepareOn(COLLATERAL, ask('borrow', '100', 'USDC'))
    expect(steps(prepared)).toEqual([
      'create_token_account',
      'refresh_reserve',
      'refresh_reserve',
      'refresh_obligation',
      'borrow',
    ])
    const borrow = action(prepared, 'borrow')
    expect(amountOf(borrow)).toBe(BigInt(100_000_000))
    expect(addressAt(borrow, 8)).toBe(associatedTokenAccount(ME, USDC.mint))
    expect(prepared.pay).toEqual({ amount: '100', symbol: 'USDC' })
    expect(() => assertKaminoLendSafe(prepared.signing, ME)).not.toThrow()
  })

  it('refuses when nothing backs it, and says what to do first', async () => {
    await expect(prepareOn({}, ask('borrow', '1', 'USDC'))).rejects.toThrow(/supply/i)
    await expect(
      prepareOn({ metadata: true, obligation: {} }, ask('borrow', '1', 'USDC'))
    ).rejects.toThrow(/supply/i)
  })

  it('refuses more than the position supports, before building anything to sign', async () => {
    const rpc = chain(COLLATERAL)
    const attempt = createKaminoLendVenue({ rpc }).prepare(ask('borrow', '501', 'USDC'), ME)
    await expect(attempt).rejects.toThrow(ChainActionRefused)
    await expect(attempt).rejects.toThrow(/at most about 500/)
    await expect(attempt).rejects.toThrow(/Nothing was signed or sent/)
    expect(rpc.simulated).toEqual([])
  })

  it('counts what is already owed, and the risk weight on the loan', async () => {
    const owing: FakeChain = {
      metadata: true,
      obligation: {
        deposits: [{ reserve: JITOSOL.reserve, cTokens: BigInt(10_000_000_000) }],
        // One SOL at $100 weighted 125% uses $125 of the $500.
        borrows: [{ reserve: SOL.reserve, amount: BigInt(1_000_000_000) }],
      },
    }
    await expect(prepareOn(owing, ask('borrow', '376', 'USDC'))).rejects.toThrow(
      /at most about 37[45]/
    )
    await expect(prepareOn(owing, ask('borrow', '374', 'USDC'))).resolves.toBeDefined()
  })

  it('counts an opening fee against the limit', async () => {
    const reserves = [{ ...USDC, originationSf: SF / BigInt(100) }, JITOSOL, SOL]
    await expect(
      prepareOn({ ...COLLATERAL, reserves }, ask('borrow', '500', 'USDC'))
    ).rejects.toThrow(/at most about 495/)
  })

  it('refuses a token Kamino won’t lend', async () => {
    await expect(prepareOn(COLLATERAL, ask('borrow', '1', 'JitoSOL'))).rejects.toThrow(
      /can’t be borrowed/
    )
  })

  it('refuses when the pool hasn’t enough ready', async () => {
    await expect(
      prepareOn(
        { ...COLLATERAL, reserves: [{ ...USDC, available: BigInt(1_000_000) }, JITOSOL, SOL] },
        ask('borrow', '100', 'USDC')
      )
    ).rejects.toThrow(/ready to lend/)
  })

  it('refuses collateral in one of Kamino’s special modes, whose limits it doesn’t read', async () => {
    await expect(
      prepareOn(
        {
          metadata: true,
          obligation: {
            elevationGroup: 1,
            deposits: [{ reserve: JITOSOL.reserve, cTokens: BigInt(10_000_000_000) }],
          },
        },
        ask('borrow', '1', 'USDC')
      )
    ).rejects.toThrow(/special mode/)
  })

  it('refuses when the network’s own run says the program would reject it', async () => {
    await expect(
      prepareOn(
        {
          ...COLLATERAL,
          simulation: {
            err: { InstructionError: [4, { Custom: 6000 }] },
            logs: ['Program log: AnchorError occurred. Error Code: BorrowTooLarge.'],
          },
        },
        ask('borrow', '100', 'USDC')
      )
    ).rejects.toThrow(/more than this position can support/)
  })

  it('shows the liquidation risk in plain words, the rate and the fee', async () => {
    const prepared = await prepareOn(COLLATERAL, ask('borrow', '300', 'USDC'))
    const text = prepared.notes.join(' ')
    // $300 owed against a $600 line (60% of $1,000): liquidation if collateral falls about half.
    expect(text).toMatch(/\$300/)
    expect(text).toMatch(/\$1,000/)
    expect(text).toMatch(/about 50%/)
    expect(text).toMatch(/sell your collateral/)
    // 50% used on a 0% to 10% curve, with 0.5% on top.
    expect(text).toMatch(/5\.6\d?% a year/)
    expect(text).not.toMatch(/\bLTV\b|\bcollateral factor\b/)
  })
})

describe('withdraw', () => {
  it('turns an amount into the receipt tokens that cover it and pays the person', async () => {
    const prepared = await prepareOn(HOLDING, ask('withdraw', '100', 'USDC'))
    expect(steps(prepared)).toEqual([
      'create_token_account',
      'init_obligation_farms',
      'refresh_reserve',
      'refresh_obligation',
      'withdraw',
    ])
    const withdraw = action(prepared, 'withdraw')
    // Reserve holds $2M for 1M receipts, so $100 takes 50.
    expect(amountOf(withdraw)).toBe(BigInt(50_000_000))
    expect(addressAt(withdraw, 9)).toBe(associatedTokenAccount(ME, USDC.mint))
    expect(prepared.receive).toEqual({ amount: '100', symbol: 'USDC', approximate: true })
    expect(() => assertKaminoLendSafe(prepared.signing, ME)).not.toThrow()
  })

  it('empties a position exactly when asked for the whole of it', async () => {
    const prepared = await prepareOn(
      HOLDING,
      ask('withdraw', '2000', 'USDC', { wholePosition: true })
    )
    expect(amountOf(action(prepared, 'withdraw'))).toBe(U64_MAX)
    expect(() => assertKaminoLendSafe(prepared.signing, ME)).not.toThrow()
  })

  it('won’t empty a position that still backs a loan', async () => {
    await expect(
      prepareOn(
        {
          metadata: true,
          obligation: {
            deposits: [{ reserve: USDC.reserve, cTokens: BigInt(1_000_000_000) }],
            borrows: [{ reserve: SOL.reserve, amount: BigInt(1_000_000_000) }],
          },
        },
        ask('withdraw', '2000', 'USDC', { wholePosition: true })
      )
    ).rejects.toThrow(/still owe/)
  })

  it('refuses more than is there', async () => {
    await expect(prepareOn(HOLDING, ask('withdraw', '2001', 'USDC'))).rejects.toThrow(
      /You have 2000/
    )
  })

  it('refuses when there is nothing at all', async () => {
    await expect(prepareOn({}, ask('withdraw', '1', 'USDC'))).rejects.toThrow(/no USDC/)
  })

  it('refuses when the pool hasn’t enough ready, and says why', async () => {
    await expect(
      prepareOn(
        { ...HOLDING, reserves: [{ ...USDC, available: BigInt(1_000_000) }] },
        ask('withdraw', '100', 'USDC')
      )
    ).rejects.toThrow(/borrowers repay/)
  })

  it('unwraps SOL back into the wallet', async () => {
    const prepared = await prepareOn(
      {
        metadata: true,
        obligation: { deposits: [{ reserve: SOL.reserve, cTokens: BigInt(1_000_000_000) }] },
      },
      ask('withdraw', '1', 'SOL')
    )
    expect(steps(prepared).at(-1)).toBe('close')
    expect(steps(prepared)[0]).toBe('create_token_account')
    expect(addressAt(action(prepared, 'withdraw'), 9)).toBe(ownWrappedSolAccount(ME))
  })
})

describe('repay', () => {
  const OWING: FakeChain = {
    metadata: true,
    obligation: {
      deposits: [{ reserve: JITOSOL.reserve, cTokens: BigInt(10_000_000_000) }],
      borrows: [{ reserve: USDC.reserve, amount: BigInt(100_000_000) }],
    },
  }

  it('pays down what was asked, from the person’s own account', async () => {
    const prepared = await prepareOn(OWING, ask('repay', '40', 'USDC'))
    expect(steps(prepared)).toEqual([
      'refresh_reserve',
      'refresh_reserve',
      'refresh_obligation',
      'repay',
    ])
    const repay = action(prepared, 'repay')
    expect(amountOf(repay)).toBe(BigInt(40_000_000))
    expect(addressAt(repay, 6)).toBe(associatedTokenAccount(ME, USDC.mint))
    expect(() => assertKaminoLendSafe(prepared.signing, ME)).not.toThrow()
  })

  it('clears the debt exactly on a whole repay, interest included', async () => {
    const prepared = await prepareOn(OWING, ask('repay', '100', 'USDC', { wholePosition: true }))
    expect(amountOf(action(prepared, 'repay'))).toBe(U64_MAX)
    expect(prepared.summary).toMatch(/all/i)
    expect(() => assertKaminoLendSafe(prepared.signing, ME)).not.toThrow()
  })

  it('wraps a little over a whole SOL debt, and returns what is left', async () => {
    const prepared = await prepareOn(
      {
        metadata: true,
        obligation: {
          deposits: [{ reserve: JITOSOL.reserve, cTokens: BigInt(10_000_000_000) }],
          borrows: [{ reserve: SOL.reserve, amount: BigInt(1_000_000_000) }],
        },
      },
      ask('repay', '1', 'SOL', { wholePosition: true })
    )
    expect(steps(prepared)).toEqual([
      'create_token_account',
      'wrap',
      'sync',
      'refresh_reserve',
      'refresh_reserve',
      'refresh_obligation',
      'repay',
      'close',
    ])
    const wrap = instructionsOf(prepared).find((i) => i.programAddress === SYSTEM)
    const lamports = readU64(wrap?.data as Uint8Array, 4)
    expect(lamports).toBeGreaterThan(BigInt(1_000_000_000))
    expect(lamports).toBeLessThan(BigInt(1_010_000_000))
    expect(amountOf(action(prepared, 'repay'))).toBe(U64_MAX)
  })

  it('refuses more than is owed', async () => {
    await expect(prepareOn(OWING, ask('repay', '101', 'USDC'))).rejects.toThrow(/You owe 100/)
  })

  it('refuses when nothing is owed in that token', async () => {
    await expect(prepareOn(OWING, ask('repay', '1', 'SOL'))).rejects.toThrow(/no SOL/)
    await expect(prepareOn({}, ask('repay', '1', 'USDC'))).rejects.toThrow(/no USDC/)
  })

  it('says so when a position is too wide for one transaction', async () => {
    const others: ReserveFixture[] = []
    let previous = ME
    for (let i = 0; i < 12; i += 1) {
      previous = associatedTokenAccount(previous, USDC.mint)
      others.push({ ...JITOSOL, reserve: previous })
    }
    await expect(
      prepareOn(
        {
          metadata: true,
          reserves: [USDC, ...others],
          obligation: {
            referrer: SOMEONE_ELSE,
            deposits: others.slice(0, 8).map(({ reserve }) => ({ reserve, cTokens: BigInt(1) })),
            borrows: [
              { reserve: USDC.reserve, amount: BigInt(100_000_000) },
              ...others.slice(8).map(({ reserve }) => ({ reserve, amount: BigInt(1) })),
            ],
          },
        },
        ask('repay', '1', 'USDC')
      )
    ).rejects.toThrow(/too many tokens/)
  })

  it('refreshes every reserve of the position in order, with the referrer’s records', async () => {
    const referrer = SOMEONE_ELSE
    const prepared = await prepareOn(
      {
        metadata: true,
        obligation: { ...OWING.obligation, referrer },
      },
      ask('repay', '1', 'USDC')
    )
    const refresh = action(prepared, 'refresh_obligation')
    expect(addressAt(refresh, 2)).toBe(JITOSOL.reserve)
    expect(addressAt(refresh, 3)).toBe(USDC.reserve)
    expect(refresh.accounts).toHaveLength(5)
  })
})

describe('positions', () => {
  it('is empty when no position exists', async () => {
    await expect(createKaminoLendVenue({ rpc: chain({}) }).positions?.(ME)).resolves.toEqual([])
  })

  it('reads what is supplied and owed, interest included', async () => {
    const positions = await createKaminoLendVenue({
      rpc: chain({
        metadata: true,
        reserves: [{ ...USDC, cumulative: SF * BigInt(2) }, JITOSOL, SOL],
        obligation: {
          deposits: [{ reserve: JITOSOL.reserve, cTokens: BigInt(10_000_000_000) }],
          // Borrowed when the running rate was 1, and it is 2 now: twice what the record says.
          borrows: [{ reserve: USDC.reserve, amount: BigInt(100_000_000), cumulative: SF }],
        },
      }),
    }).positions?.(ME)
    expect(positions?.find((p) => p.slot === 'supplied')).toMatchObject({
      symbol: 'JitoSOL',
      amount: '10',
    })
    const borrowed = positions?.find((p) => p.slot === 'borrowed')
    expect(borrowed?.symbol).toBe('USDC')
    expect(Number(borrowed?.amount)).toBeGreaterThanOrEqual(200)
    expect(Number(borrowed?.amount)).toBeLessThan(200.01)
  })

  it('never lets an unlisted reserve pass as a listed token', async () => {
    const other = '6pazpY4icuXZ5sb2jMWAqdG4TtbUoY1SJ45237Fjht9h'
    const positions = await createKaminoLendVenue({
      rpc: chain({
        metadata: true,
        reserves: [{ ...USDC, reserve: other, name: 'USDC' }],
        obligation: { deposits: [{ reserve: other, cTokens: BigInt(1_000_000) }] },
      }),
    }).positions?.(ME)
    expect(positions?.[0]?.symbol).toBe('USDC (not listed here)')
  })

  it('throws when the chain can’t be read, rather than saying nothing is there', async () => {
    await expect(
      createKaminoLendVenue({ rpc: chain({ unreadable: true }) }).positions?.(ME)
    ).rejects.toThrow()
  })

  it('throws on a position that isn’t the person’s', async () => {
    await expect(
      createKaminoLendVenue({
        rpc: chain({ obligation: { owner: SOMEONE_ELSE } }),
      }).positions?.(ME)
    ).rejects.toThrow()
  })

  it('throws when a reserve it needs is missing', async () => {
    await expect(
      createKaminoLendVenue({
        rpc: chain({
          reserves: [],
          obligation: { deposits: [{ reserve: USDC.reserve, cTokens: BigInt(1) }] },
        }),
      }).positions?.(ME)
    ).rejects.toThrow()
  })
})

describe('what is refused at signing', () => {
  const build = (fake: FakeChain, request: ChainActionRequest) => prepareOn(fake, request)
  const OWING: FakeChain = {
    metadata: true,
    obligation: {
      deposits: [{ reserve: JITOSOL.reserve, cTokens: BigInt(10_000_000_000) }],
      borrows: [{ reserve: USDC.reserve, amount: BigInt(100_000_000) }],
    },
  }
  const COLLATERAL: FakeChain = {
    metadata: true,
    obligation: { deposits: [{ reserve: JITOSOL.reserve, cTokens: BigInt(10_000_000_000) }] },
  }

  function replaced(
    prepared: PreparedAction,
    name: string,
    change: (i: ReturnType<typeof action>) => ReturnType<typeof action>
  ) {
    const target = hex(Uint8Array.from(action(prepared, name).data ?? []))
    return [
      ...budget,
      ...rebuilt(prepared, ME)
        .filter((i) => !i.programAddress.startsWith('ComputeBudget'))
        .map((i) => (hex(Uint8Array.from(i.data ?? [])) === target ? change(i) : i)),
    ]
  }

  it('accepts its own build, rebuilt unchanged', async () => {
    const prepared = await build(COLLATERAL, ask('borrow', '100', 'USDC'))
    expect(() =>
      assertKaminoLendSafe(
        payload(
          ME,
          replaced(prepared, 'borrow', (i) => i)
        ),
        ME
      )
    ).not.toThrow()
  })

  it.each([
    ['borrow', 'to someone else’s account', 8, associatedTokenAccount(SOMEONE_ELSE, USDC.mint)],
    ['borrow', 'to a listed reserve’s other mint', 5, JITOSOL.mint],
    ['borrow', 'from someone else’s position', 1, obligationAddress(SOMEONE_ELSE)],
    ['borrow', 'in another market', 2, 'DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek'],
    ['borrow', 'from an unlisted reserve', 4, '6pazpY4icuXZ5sb2jMWAqdG4TtbUoY1SJ45237Fjht9h'],
    ['borrow', 'through another token program', 10, UNKNOWN_PROGRAM],
    ['borrow', 'with a stranger as the owner', 0, SOMEONE_ELSE],
  ])('refuses a %s %s', async (name, _what, position, address) => {
    const prepared = await build(COLLATERAL, ask('borrow', '100', 'USDC'))
    const tampered = replaced(prepared, name, (i) => withAccount(i, position, address))
    expect(() => assertKaminoLendSafe(payload(ME, tampered), ME)).toThrow(ChainActionRefused)
  })

  it('refuses a withdraw paid to someone else', async () => {
    const prepared = await build(HOLDING, ask('withdraw', '1', 'USDC'))
    const tampered = replaced(prepared, 'withdraw', (i) =>
      withAccount(i, 9, associatedTokenAccount(SOMEONE_ELSE, USDC.mint))
    )
    expect(() => assertKaminoLendSafe(payload(ME, tampered), ME)).toThrow(/isn’t what Kamino Lend/)
  })

  it('refuses a repay drawn from someone else’s account', async () => {
    const prepared = await build(OWING, ask('repay', '1', 'USDC'))
    const tampered = replaced(prepared, 'repay', (i) =>
      withAccount(i, 6, associatedTokenAccount(SOMEONE_ELSE, USDC.mint))
    )
    expect(() => assertKaminoLendSafe(payload(ME, tampered), ME)).toThrow(ChainActionRefused)
  })

  it('refuses a deposit against someone else’s position', async () => {
    const prepared = await build(HOLDING, ask('supply', '1', 'USDC'))
    const tampered = replaced(prepared, 'deposit', (i) =>
      withAccount(i, 1, obligationAddress(SOMEONE_ELSE))
    )
    expect(() => assertKaminoLendSafe(payload(ME, tampered), ME)).toThrow(ChainActionRefused)
  })

  it('refuses a borrow of everything the pool will give', async () => {
    const prepared = await build(COLLATERAL, ask('borrow', '100', 'USDC'))
    const tampered = replaced(prepared, 'borrow', (i) => ({
      ...i,
      data: Uint8Array.from([...(i.data ?? []).slice(0, 8), ...u64Bytes(U64_MAX)]),
    }))
    expect(() => assertKaminoLendSafe(payload(ME, tampered), ME)).toThrow(ChainActionRefused)
  })

  it.each([
    ['extra bytes', withExtraData],
    ['another function', withOtherFunction],
  ])('refuses the action with %s', async (_what, change) => {
    const prepared = await build(COLLATERAL, ask('borrow', '100', 'USDC'))
    const tampered = replaced(prepared, 'borrow', change)
    expect(() => assertKaminoLendSafe(payload(ME, tampered), ME)).toThrow(ChainActionRefused)
  })

  it('refuses a second money step, a transfer out, an approval or an unknown program', async () => {
    const prepared = await build(COLLATERAL, ask('borrow', '100', 'USDC'))
    const base = replaced(prepared, 'borrow', (i) => i)
    const own = associatedTokenAccount(ME, USDC.mint)
    for (const extra of [
      action(prepared, 'borrow'),
      transferOf(ME, SOMEONE_ELSE, BigInt(1000)),
      unlimitedApproval(own, SOMEONE_ELSE, ME),
      { programAddress: UNKNOWN_PROGRAM as never, data: Uint8Array.of(1) },
    ]) {
      expect(() => assertKaminoLendSafe(payload(ME, [...base, extra]), ME)).toThrow(
        ChainActionRefused
      )
    }
  })

  it('refuses a position set up with someone else’s referral', async () => {
    const prepared = await build({}, ask('supply', '1', 'USDC'))
    const tampered = replaced(prepared, 'init_user_metadata', (i) =>
      withAccount(i, 3, userMetadataAddress(SOMEONE_ELSE))
    )
    expect(() => assertKaminoLendSafe(payload(ME, tampered), ME)).toThrow(ChainActionRefused)
  })

  it('refuses a farm record not belonging to this position', async () => {
    const prepared = await build(HOLDING, ask('withdraw', '1', 'USDC'))
    const tampered = replaced(prepared, 'withdraw', (i) => withAccount(i, 14, SOMEONE_ELSE))
    expect(() => assertKaminoLendSafe(payload(ME, tampered), ME)).toThrow(ChainActionRefused)
  })

  it('refuses SOL wrapped into someone else’s account', async () => {
    const prepared = await build(HOLDING, ask('supply', '1', 'SOL'))
    const instructions = rebuilt(prepared, ME).filter(
      (i) => !i.programAddress.startsWith('ComputeBudget')
    )
    const tampered = [
      ...budget,
      ...instructions.map((i) =>
        i.programAddress === SYSTEM
          ? transferOf(ME, ownWrappedSolAccount(SOMEONE_ELSE), BigInt(1_000_000_000))
          : i
      ),
    ]
    expect(() => assertKaminoLendSafe(payload(ME, tampered), ME)).toThrow(ChainActionRefused)
  })

  it('refuses another wallet as payer or signer', async () => {
    const prepared = await build(COLLATERAL, ask('borrow', '100', 'USDC'))
    expect(() => assertKaminoLendSafe(prepared.signing, SOMEONE_ELSE)).toThrow(ChainActionRefused)
  })

  it('refuses anything but Solana', () => {
    expect(() => assertKaminoLendSafe({ family: 'sui', transaction: 'AA==' }, ME)).toThrow(
      ChainActionRefused
    )
  })

  it('refuses a transaction with no money step at all', () => {
    expect(() => assertKaminoLendSafe(payload(ME, [...budget]), ME)).toThrow(ChainActionRefused)
  })
})
