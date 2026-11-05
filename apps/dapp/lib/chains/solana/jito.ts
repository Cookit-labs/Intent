import { isAddress } from '@solana/kit'

import {
  ChainActionRefused,
  takesOnly,
  toBaseUnits,
  type ChainActionRequest,
  type ChainVenue,
  type PreparedAction,
  type SigningPayload,
  type VenueQuote,
} from '../types'
import {
  assertStakeShape,
  compileForSigning,
  computeBudget,
  createTokenAccount,
  createTokenAccountRule,
  depositSol,
  depositSolRule,
  feePercentText,
  lamportsForWithdrawal,
  poolTokensForDeposit,
  poolWithdrawAuthority,
  rateText,
  readAccount,
  readOnlyRpc,
  readStakePool,
  stakedTokenOrRefuse,
  withdrawSol,
  withdrawSolRule,
  withSlippage,
  type SolanaRpc,
  type StakePoolState,
  type StakeShape,
} from './stake-pool'
import { fromBaseUnits } from './tokens'

/**
 * https://go.jito.network/docs/jitosol/jitosol-liquid-staking/for-developers/staking-integration/
 * names both. On chain on 5 November 2026 the pool is owned by the SPL stake pool program and its
 * `pool_mint` field is this mint.
 */
export const JITO_STAKE_POOL = 'Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb'
export const JITOSOL_MINT = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'

const SOL_DECIMALS = 9
const JITOSOL_DECIMALS = 9
/** Depositing and creating the token account use under 100,000 units. */
const COMPUTE_UNITS = 150_000
/** Left in the reserve, since the program won't empty it past what the account must keep. */
const RESERVE_MARGIN_LAMPORTS = BigInt(10_000_000)

export function jitoShapes(account: string): readonly StakeShape[] {
  return [
    {
      rules: [
        createTokenAccountRule(account, JITOSOL_MINT),
        depositSolRule(account, JITO_STAKE_POOL, JITOSOL_MINT),
      ],
    },
    { rules: [withdrawSolRule(account, JITO_STAKE_POOL, JITOSOL_MINT)] },
  ]
}

function assertPersonAlone(state: StakePoolState, kind: 'stake' | 'unstake'): void {
  const gate = kind === 'stake' ? state.solDepositAuthority : state.solWithdrawAuthority
  if (gate !== undefined) {
    throw new ChainActionRefused(
      `Jito’s stake pool now needs another signature to ${kind} SOL, so I stopped. Nothing was signed or sent.`
    )
  }
}

export interface JitoOptions {
  env?: Record<string, string | undefined>
  rpc?: SolanaRpc
}

export function createJitoVenue(options: JitoOptions = {}): ChainVenue {
  const rpc = options.rpc ?? readOnlyRpc(options.env)

  async function checkedStake(request: ChainActionRequest, account: string) {
    if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
    stakedTokenOrRefuse('Jito', 'stake', request.tokenIn, 'SOL', 'stake 1 SOL with Jito')
    const lamports = BigInt(toBaseUnits(request.amount, SOL_DECIMALS))
    const state = await readStakePool(rpc, 'Jito', JITO_STAKE_POOL, JITOSOL_MINT)
    assertPersonAlone(state, 'stake')
    const poolTokens = poolTokensForDeposit(state, lamports)
    if (poolTokens === BigInt(0)) {
      throw new ChainActionRefused(
        'That amount is too small to mint any JitoSOL. Nothing was signed or sent.'
      )
    }
    return { state, lamports, poolTokens }
  }

  async function checkedUnstake(request: ChainActionRequest, account: string) {
    if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
    stakedTokenOrRefuse(
      'Jito',
      'unstake',
      request.tokenIn,
      'JitoSOL',
      'unstake 1 JitoSOL from Jito'
    )
    const poolTokens = BigInt(toBaseUnits(request.amount, JITOSOL_DECIMALS))
    const state = await readStakePool(rpc, 'Jito', JITO_STAKE_POOL, JITOSOL_MINT)
    assertPersonAlone(state, 'unstake')
    const lamports = lamportsForWithdrawal(state, poolTokens, state.solWithdrawalFee)
    if (lamports === BigInt(0)) {
      throw new ChainActionRefused(
        'That amount is too small to return any SOL. Nothing was signed or sent.'
      )
    }
    const reserve = await readAccount(rpc, state.reserveStake)
    if (reserve.lamports < lamports + RESERVE_MARGIN_LAMPORTS) {
      throw new ChainActionRefused(
        'Jito’s pool doesn’t hold enough ready SOL for this right now. Nothing was signed or sent. Try a smaller amount, or swap JitoSOL for SOL on Jupiter instead.'
      )
    }
    return { state, lamports, poolTokens }
  }

  async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
    const { poolTokens } = await checkedStake(request, account)
    return {
      receive: {
        amount: fromBaseUnits(poolTokens.toString(), JITOSOL_DECIMALS),
        symbol: 'JitoSOL',
      },
    }
  }

  async function prepareStake(
    request: ChainActionRequest,
    account: string
  ): Promise<PreparedAction> {
    const { state, lamports, poolTokens } = await checkedStake(request, account)
    const transaction = await compileForSigning(rpc, account, [
      ...computeBudget(COMPUTE_UNITS),
      createTokenAccount(account, JITOSOL_MINT),
      depositSol({
        pool: JITO_STAKE_POOL,
        state,
        withdrawAuthority: await poolWithdrawAuthority(JITO_STAKE_POOL),
        account,
        lamports,
        minimumPoolTokens: withSlippage(poolTokens),
      }),
    ])
    const receive = fromBaseUnits(poolTokens.toString(), JITOSOL_DECIMALS)
    return {
      venueId: 'jito',
      venueName: 'Jito',
      kind: 'stake',
      summary: `Stake ${request.amount} SOL directly into Jito’s stake pool for about ${receive} JitoSOL.`,
      pay: { amount: request.amount, symbol: 'SOL' },
      receive: { amount: receive, symbol: 'JitoSOL', approximate: true },
      notes: [
        `1 JitoSOL is worth about ${rateText(state.totalLamports, state.poolTokenSupply)} SOL, read from the pool on chain just now. It rises as rewards arrive, so you get fewer JitoSOL than the SOL you put in.`,
        `I’m not showing a yearly rate because the pool doesn’t state one, and rewards aren’t guaranteed. Jito keeps ${feePercentText(state.epochFee)} of rewards, read on chain.`,
        `To get out, "unstake" JitoSOL here for SOL straight away, minus the pool’s ${feePercentText(state.solWithdrawalFee)} fee, while its reserve holds enough. If it doesn’t, you can sell JitoSOL on the market, where the price can differ.`,
        'Your SOL sits in the SPL stake pool program, which can be upgraded by its authority, and Jito’s manager and staker keys can change fees and validators. Smart contract failure or poor validator performance could lose you money.',
      ],
      signing: { family: 'solana', transaction },
    }
  }

  async function prepareUnstake(
    request: ChainActionRequest,
    account: string
  ): Promise<PreparedAction> {
    const { state, lamports, poolTokens } = await checkedUnstake(request, account)
    const transaction = await compileForSigning(rpc, account, [
      ...computeBudget(COMPUTE_UNITS),
      withdrawSol({
        pool: JITO_STAKE_POOL,
        state,
        withdrawAuthority: await poolWithdrawAuthority(JITO_STAKE_POOL),
        account,
        poolTokens,
        minimumLamports: withSlippage(lamports),
      }),
    ])
    const receive = fromBaseUnits(lamports.toString(), SOL_DECIMALS)
    return {
      venueId: 'jito',
      venueName: 'Jito',
      kind: 'unstake',
      summary: `Unstake ${request.amount} JitoSOL from Jito’s stake pool for about ${receive} SOL, paid to your wallet now.`,
      pay: { amount: request.amount, symbol: 'JitoSOL' },
      receive: { amount: receive, symbol: 'SOL', approximate: true },
      notes: [
        `This takes SOL from the pool’s ready reserve, so there is no waiting. The pool charges ${feePercentText(state.solWithdrawalFee)} in JitoSOL, read on chain, and the amount above is after that fee.`,
        `1 JitoSOL is worth about ${rateText(state.totalLamports, state.poolTokenSupply)} SOL, read on chain just now. This fails with nothing moved if the rate falls more than 0.1% before it lands.`,
      ],
      signing: { family: 'solana', transaction },
    }
  }

  return {
    id: 'jito',
    name: 'Jito',
    kinds: ['stake', 'unstake'],
    assertCanFollow: takesOnly('Jito', ['SOL']),
    quote,
    prepare: (request, account) =>
      request.kind === 'unstake'
        ? prepareUnstake(request, account)
        : request.kind === 'stake'
          ? prepareStake(request, account)
          : Promise.reject(
              new ChainActionRefused(
                `Jito here can stake and unstake, not ${request.kind}. Nothing was signed or sent.`
              )
            ),
    assertSafe: (payload: SigningPayload, account: string) =>
      assertStakeShape(payload, account, 'Jito', jitoShapes(account)),
  }
}
