import { isAddress, type Address, type Instruction } from '@solana/kit'

import {
  ChainActionRefused,
  takesOnly,
  toBaseUnits,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
  type SigningPayload,
  type VenueQuote,
} from '../types'
import { associatedTokenAccount, SYSTEM_PROGRAM, TOKEN_PROGRAM } from './assert-safe'
import {
  accountRoles,
  anchorAmountData,
  assertStakeShape,
  compileForSigning,
  computeBudget,
  createTokenAccount,
  createTokenAccountRule,
  rateText,
  readAccount,
  readAddress,
  readOnlyRpc,
  readU32,
  readU64,
  stakedTokenOrRefuse,
  type InstructionRule,
  type SolanaRpc,
  type StakeShape,
} from './stake-pool'
import { fromBaseUnits } from './tokens'

const { readonly, signer, writable } = accountRoles

/**
 * https://docs.marinade.finance/developers/contract-addresses: "Liquid-staking-program", its "Main
 * state account" and "mSOL mint (mainnet-beta)". On chain on 5 November 2026 the program is
 * executable, the state is owned by it and its first field is this mint, and the mint decimals are 9.
 */
export const MARINADE_PROGRAM = 'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD'
export const MARINADE_STATE = '8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC'
export const MSOL_MINT = 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'

export const MARINADE_TOKENS: ChainToken[] = [
  { symbol: 'mSOL', id: MSOL_MINT, decimals: 9, name: 'Marinade staked SOL' },
]

/**
 * The program's own addresses, seen in live `deposit` and `liquid_unstake` transactions on
 * 5 November 2026. The leg and treasury are also fields of the state, checked at every read. The
 * others are derived from the state by `seeds` the program checks itself.
 */
const LIQ_POOL_SOL_LEG = 'UefNb6z6yvArqe4cJHTXCqStRsKmWhGxnZzuHbikP5Q'
const LIQ_POOL_MSOL_LEG = '7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE'
const LIQ_POOL_MSOL_LEG_AUTHORITY = 'EyaSjUtSgo9aRD1f8LWXwdvkpDTmXAW54yoSHZRF14WL'
const TREASURY_MSOL = 'B1aLzaNMeFVAyQ6f3XbbUyKcH2YPHu2fqiEagmiF23VR'
const RESERVE = 'Du3Ysj1wKbxPKkuPPnvzQLQh8oMSVifs3jGZjJWXFmHN'
const MSOL_MINT_AUTHORITY = '3JLPCS1qM2zRw3Dp6V4hZnYHd4toMNPkNesXdX9tg6KM'

/** Anchor discriminators, sha256("global:<name>"), and seen in the same live transactions. */
const DEPOSIT = 'f223c68952e1f2b6'
const LIQUID_UNSTAKE = '1e1e77f0bfe30c10'

const SOL_DECIMALS = 9
const MSOL_DECIMALS = 9
const COMPUTE_UNITS = 200_000
const BASIS_POINTS = BigInt(10_000)
const BP_CENTS = BigInt(1_000_000)

/**
 * A liquid unstake can't carry a minimum out: the instruction takes only an amount. So the fee is
 * read and shown, and a fee above this is refused. On 5 November 2026 the pool's curve ran from
 * 0.03% to a maximum of 1.5%, and it stood near 1.45% with the pool far under its target.
 */
const MAX_UNSTAKE_FEE_BP = BigInt(200)

export interface MarinadeState {
  msolMint: string
  treasury: string
  msolLeg: string
  rentExemptForTokenAcc: bigint
  liquidityTarget: bigint
  lpMaxFeeBp: bigint
  lpMinFeeBp: bigint
  totalVirtualStaked: bigint
  msolSupply: bigint
  minDeposit: bigint
  minWithdraw: bigint
  stakingCap: bigint
  totalUnderControl: bigint
  paused: boolean
  delayedUnstakeFeeBpCents: bigint
  depositFeeBpCents: bigint
}

/** `programs/marinade-finance/src/state/mod.rs` `State`, in its Borsh layout. */
export function decodeMarinadeState(data: Uint8Array): MarinadeState | undefined {
  if (data.length < 647) return undefined
  const activeBalance = readU64(data, 376)
  const coolingDown = readU64(data, 226) + readU64(data, 568)
  const reserve = readU64(data, 496)
  const tickets = readU64(data, 528)
  const totalUnderControl = activeBalance + coolingDown + reserve
  // A fixed offset ends here, because this enum's size depends on its variant.
  const upgrader = data[638]
  const after = 639 + (upgrader === 0 ? 20 : upgrader === 1 ? 12 : 0)
  if (upgrader === undefined || upgrader > 2 || after + 4 > data.length) return undefined
  return {
    msolMint: readAddress(data, 8),
    treasury: readAddress(data, 104),
    msolLeg: readAddress(data, 420),
    rentExemptForTokenAcc: readU64(data, 138),
    liquidityTarget: readU64(data, 452),
    lpMaxFeeBp: BigInt(readU32(data, 460)),
    lpMinFeeBp: BigInt(readU32(data, 464)),
    totalVirtualStaked: totalUnderControl > tickets ? totalUnderControl - tickets : BigInt(0),
    msolSupply: readU64(data, 504),
    minDeposit: readU64(data, 544),
    minWithdraw: readU64(data, 552),
    stakingCap: readU64(data, 560),
    totalUnderControl,
    paused: data[608] !== 0,
    delayedUnstakeFeeBpCents: BigInt(readU32(data, 609)),
    depositFeeBpCents: BigInt(readU32(data, after)),
  }
}

/** mSOL a SOL deposit gives, at the rate read. `deposit.rs`. */
export function msolForDeposit(state: MarinadeState, lamports: bigint): bigint {
  const afterFee = lamports - (lamports * state.depositFeeBpCents) / BP_CENTS
  return (afterFee * state.msolSupply) / state.totalVirtualStaked
}

export interface LiquidUnstake {
  feeBp: bigint
  lamports: bigint
}

/** What `liquid_unstake.rs` pays for an amount of mSOL. The fee falls as the SOL leg fills. */
export function liquidUnstake(
  state: MarinadeState,
  msol: bigint,
  solLegLamports: bigint
): LiquidUnstake {
  const toValue = (amount: bigint): bigint => (amount * state.totalVirtualStaked) / state.msolSupply
  const removed = toValue(msol)
  const available =
    solLegLamports > state.rentExemptForTokenAcc
      ? solLegLamports - state.rentExemptForTokenAcc
      : BigInt(0)
  let feeBp = state.lpMaxFeeBp
  if (removed < available) {
    const left = available - removed
    feeBp =
      left >= state.liquidityTarget
        ? state.lpMinFeeBp
        : state.lpMaxFeeBp - ((state.lpMaxFeeBp - state.lpMinFeeBp) * left) / state.liquidityTarget
  }
  return { feeBp, lamports: toValue(msol - (msol * feeBp) / BASIS_POINTS) }
}

function percentText(basisPoints: bigint): string {
  return `${Number(basisPoints) / 100}%`
}

function delayedUnstakeText(state: MarinadeState): string {
  return `Marinade’s delayed unstake charges ${Number(state.delayedUnstakeFeeBpCents) / 10_000}%, read on chain, but waits for the Solana epoch to end, about two days and sometimes one epoch more, and isn’t wired here.`
}

function hasAmount(data: Uint8Array): boolean {
  return readU64(data, 8) > BigInt(0)
}

function depositRule(account: string): InstructionRule {
  return {
    program: MARINADE_PROGRAM,
    prefix: DEPOSIT,
    length: 16,
    accountCount: 11,
    accounts: {
      0: MARINADE_STATE,
      1: MSOL_MINT,
      6: account,
      7: associatedTokenAccount(account, MSOL_MINT),
      9: SYSTEM_PROGRAM,
      10: TOKEN_PROGRAM,
    },
    also: ({ data }) => hasAmount(data),
  }
}

function liquidUnstakeRule(account: string): InstructionRule {
  return {
    program: MARINADE_PROGRAM,
    prefix: LIQUID_UNSTAKE,
    length: 16,
    accountCount: 10,
    accounts: {
      0: MARINADE_STATE,
      1: MSOL_MINT,
      5: associatedTokenAccount(account, MSOL_MINT),
      6: account,
      7: account,
      8: SYSTEM_PROGRAM,
      9: TOKEN_PROGRAM,
    },
    also: ({ data }) => hasAmount(data),
  }
}

export function marinadeShapes(account: string): readonly StakeShape[] {
  return [
    { rules: [createTokenAccountRule(account, MSOL_MINT), depositRule(account)] },
    { rules: [liquidUnstakeRule(account)] },
  ]
}

function depositInstruction(account: string, lamports: bigint): Instruction {
  return {
    programAddress: MARINADE_PROGRAM as Address,
    accounts: [
      writable(MARINADE_STATE),
      writable(MSOL_MINT),
      writable(LIQ_POOL_SOL_LEG),
      writable(LIQ_POOL_MSOL_LEG),
      readonly(LIQ_POOL_MSOL_LEG_AUTHORITY),
      writable(RESERVE),
      signer(account),
      writable(associatedTokenAccount(account, MSOL_MINT)),
      readonly(MSOL_MINT_AUTHORITY),
      readonly(SYSTEM_PROGRAM),
      readonly(TOKEN_PROGRAM),
    ],
    data: anchorAmountData(DEPOSIT, lamports),
  }
}

function liquidUnstakeInstruction(account: string, msol: bigint): Instruction {
  return {
    programAddress: MARINADE_PROGRAM as Address,
    accounts: [
      writable(MARINADE_STATE),
      writable(MSOL_MINT),
      writable(LIQ_POOL_SOL_LEG),
      writable(LIQ_POOL_MSOL_LEG),
      writable(TREASURY_MSOL),
      writable(associatedTokenAccount(account, MSOL_MINT)),
      signer(account),
      writable(account),
      readonly(SYSTEM_PROGRAM),
      readonly(TOKEN_PROGRAM),
    ],
    data: anchorAmountData(LIQUID_UNSTAKE, msol),
  }
}

export interface MarinadeOptions {
  env?: Record<string, string | undefined>
  rpc?: SolanaRpc
}

/**
 * mSOL only. Marinade Native isn't here: Marinade's docs list a staker authority and a proxy for it,
 * but no page I could read says how a wallet enters and leaves it unaided.
 */
export function createMarinadeVenue(options: MarinadeOptions = {}): ChainVenue {
  const rpc = options.rpc ?? readOnlyRpc(options.env)

  async function readState(): Promise<MarinadeState> {
    const account = await readAccount(rpc, MARINADE_STATE)
    const state = account.owner === MARINADE_PROGRAM ? decodeMarinadeState(account.data) : undefined
    if (
      state === undefined ||
      state.msolMint !== MSOL_MINT ||
      state.msolLeg !== LIQ_POOL_MSOL_LEG ||
      state.treasury !== TREASURY_MSOL ||
      state.msolSupply === BigInt(0) ||
      state.totalVirtualStaked === BigInt(0)
    ) {
      throw new ChainActionRefused(
        'Marinade’s state doesn’t look as expected on chain, so I stopped. Nothing was signed or sent.'
      )
    }
    if (state.paused) {
      throw new ChainActionRefused(
        'Marinade is paused on chain right now. Nothing was signed or sent, so try again later.'
      )
    }
    return state
  }

  async function checkedStake(request: ChainActionRequest, account: string) {
    if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
    stakedTokenOrRefuse('Marinade', 'stake', request.tokenIn, 'SOL', 'stake 1 SOL with Marinade')
    const lamports = BigInt(toBaseUnits(request.amount, SOL_DECIMALS))
    const state = await readState()
    if (lamports < state.minDeposit) {
      throw new ChainActionRefused(
        `Marinade takes at least ${fromBaseUnits(state.minDeposit.toString(), SOL_DECIMALS)} SOL. Nothing was signed or sent.`
      )
    }
    if (state.totalUnderControl + lamports > state.stakingCap) {
      throw new ChainActionRefused(
        'Marinade’s staking cap is full right now. Nothing was signed or sent.'
      )
    }
    const msol = msolForDeposit(state, lamports)
    if (msol === BigInt(0)) {
      throw new ChainActionRefused(
        'That amount is too small to give any mSOL. Nothing was signed or sent.'
      )
    }
    return { state, lamports, msol }
  }

  async function checkedUnstake(request: ChainActionRequest, account: string) {
    if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
    stakedTokenOrRefuse(
      'Marinade',
      'unstake',
      request.tokenIn,
      'mSOL',
      'unstake 1 mSOL from Marinade'
    )
    const msol = BigInt(toBaseUnits(request.amount, MSOL_DECIMALS))
    const [state, solLeg] = await Promise.all([readState(), readAccount(rpc, LIQ_POOL_SOL_LEG)])
    const { feeBp, lamports } = liquidUnstake(state, msol, solLeg.lamports)
    if (lamports + state.rentExemptForTokenAcc > solLeg.lamports) {
      throw new ChainActionRefused(
        'Marinade’s instant-unstake pool doesn’t hold enough SOL for this right now. Nothing was signed or sent. Try a smaller amount, or swap mSOL for SOL on the market instead.'
      )
    }
    if (lamports < state.minWithdraw || lamports === BigInt(0)) {
      throw new ChainActionRefused(
        'That amount is too small to unstake from Marinade. Nothing was signed or sent.'
      )
    }
    if (feeBp > MAX_UNSTAKE_FEE_BP) {
      throw new ChainActionRefused(
        `Marinade’s instant-unstake fee is ${percentText(feeBp)} right now, which is too high to build. Nothing was signed or sent. Try a smaller amount, or wait for the pool to refill.`
      )
    }
    return { state, msol, lamports, feeBp }
  }

  async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
    const { msol } = await checkedStake(request, account)
    return { receive: { amount: fromBaseUnits(msol.toString(), MSOL_DECIMALS), symbol: 'mSOL' } }
  }

  async function prepareStake(
    request: ChainActionRequest,
    account: string
  ): Promise<PreparedAction> {
    const { state, lamports, msol } = await checkedStake(request, account)
    const transaction = await compileForSigning(rpc, account, [
      ...computeBudget(COMPUTE_UNITS),
      createTokenAccount(account, MSOL_MINT),
      depositInstruction(account, lamports),
    ])
    const receive = fromBaseUnits(msol.toString(), MSOL_DECIMALS)
    return {
      venueId: 'marinade',
      venueName: 'Marinade',
      kind: 'stake',
      summary: `Stake ${request.amount} SOL with Marinade for about ${receive} mSOL.`,
      pay: { amount: request.amount, symbol: 'SOL' },
      receive: { amount: receive, symbol: 'mSOL', approximate: true },
      notes: [
        `1 mSOL is worth about ${rateText(state.totalVirtualStaked, state.msolSupply)} SOL, read from Marinade’s state on chain just now. It rises as rewards arrive, so you get fewer mSOL than the SOL you put in.`,
        'I’m not showing a yearly rate because Marinade’s program doesn’t state one, and rewards aren’t guaranteed.',
        `To get out, "unstake" mSOL here for SOL straight away through Marinade’s pool, for a fee that depends on how much SOL it holds, ${percentText(state.lpMinFeeBp)} to ${percentText(state.lpMaxFeeBp)} right now. ${delayedUnstakeText(state)}`,
        'Marinade’s program can be upgraded by a 6-of-13 multisig, and a 3-of-5 council holds its admin powers, including the fees. It has audits from Neodyme, Ackee and Kudelski, which don’t rule out a failure that could lose you money.',
      ],
      signing: { family: 'solana', transaction },
    }
  }

  async function prepareUnstake(
    request: ChainActionRequest,
    account: string
  ): Promise<PreparedAction> {
    const { state, msol, lamports, feeBp } = await checkedUnstake(request, account)
    const transaction = await compileForSigning(rpc, account, [
      ...computeBudget(COMPUTE_UNITS),
      liquidUnstakeInstruction(account, msol),
    ])
    const receive = fromBaseUnits(lamports.toString(), SOL_DECIMALS)
    return {
      venueId: 'marinade',
      venueName: 'Marinade',
      kind: 'unstake',
      summary: `Unstake ${request.amount} mSOL through Marinade’s pool for about ${receive} SOL, paid to your wallet now, after a ${percentText(feeBp)} fee.`,
      pay: { amount: request.amount, symbol: 'mSOL' },
      receive: { amount: receive, symbol: 'SOL', approximate: true },
      notes: [
        `This is a sale into Marinade’s SOL pool, not a release of your stake. The fee is ${percentText(feeBp)} right now, read on chain, and depends on how much SOL the pool holds.`,
        `Marinade’s program takes no minimum for this, so if the pool empties before this lands the fee can rise to its ${percentText(state.lpMaxFeeBp)} maximum, and you’d get less than shown.`,
        `${delayedUnstakeText(state)} A swap on the market may also pay better.`,
      ],
      signing: { family: 'solana', transaction },
    }
  }

  return {
    id: 'marinade',
    name: 'Marinade',
    kinds: ['stake', 'unstake'],
    assertCanFollow: takesOnly('Marinade', ['SOL']),
    quote,
    prepare: (request, account) =>
      request.kind === 'unstake'
        ? prepareUnstake(request, account)
        : request.kind === 'stake'
          ? prepareStake(request, account)
          : Promise.reject(
              new ChainActionRefused(
                `Marinade here can stake and unstake, not ${request.kind}. Nothing was signed or sent.`
              )
            ),
    assertSafe: (payload: SigningPayload, account: string) =>
      assertStakeShape(payload, account, 'Marinade', marinadeShapes(account)),
  }
}
