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
import {
  ASSOCIATED_TOKEN_PROGRAM,
  associatedTokenAccount,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
} from './assert-safe'
import {
  accountRoles,
  addressWithSeed,
  anchorAmountData,
  assertStakeShape,
  compileForSigning,
  computeBudget,
  createStakeAccountRule,
  createStakeAccountWithSeed,
  createTokenAccount,
  createTokenAccountRule,
  deactivateStake,
  deactivateStakeRule,
  decodeValidatorList,
  depositSol,
  depositSolRule,
  feePercentText,
  lamportsForWithdrawal,
  poolTokensForDeposit,
  poolWithdrawAuthority,
  rateText,
  readAccount,
  readMinimumDelegation,
  readOnlyRpc,
  readStakeAccountRent,
  readStakePool,
  readU64,
  STAKE_PROGRAM,
  stakedTokenOrRefuse,
  validatorStakeAccount,
  withdrawStake,
  withdrawStakeRule,
  withSlippage,
  type InstructionRule,
  type PoolValidator,
  type SolanaRpc,
  type StakePoolState,
  type StakeShape,
} from './stake-pool'
import { fromBaseUnits } from './tokens'

const { readonly, signer, writable } = accountRoles

/**
 * https://docs.solayer.org/resources/solayer-programs.md lists the Pool Manager and calls sSOL's
 * mint a program. https://github.com/solayer-labs/solayer-cli, `restaking/utils/constants.ts` and
 * its README, name the restaking pool, the LP mint and the stake pool. On chain on 5 November 2026
 * the program is executable, the restaking pool is owned by it and holds these two mints, the stake
 * pool is owned by the SPL stake pool program with this LP mint, and both mints use the Token Program.
 */
export const SOLAYER_RESTAKING_PROGRAM = 'sSo1iU21jBrU9VaJ8PJib1MtorefUV4fzC9GURa2KNn'
export const SOLAYER_RESTAKING_POOL = '3sk58CzpitB9jsnVzZWwqeCn2zcXVherhALBh88Uw9GQ'
export const SOLAYER_STAKE_POOL = 'po1osKDWYF9oiVEGmzKA4eTs8eMveFRMox3bUKazGN2'
export const SOLAYER_LP_MINT = 'sSo1wxKKr6zW2hqf5hZrp2CawLibcwi1pMBqk5bg2G4'
export const SSOL_MINT = 'sSo14endRuUbvQaJS3dq36Q829a3A6BEfoeeRGJywEh'

export const SOLAYER_TOKENS: ChainToken[] = [
  { symbol: 'sSOL', id: SSOL_MINT, decimals: 9, name: 'Solayer restaked SOL' },
]

/** `getAssociatedTokenAddressSync(LP mint, restaking pool)`, as `unrestake_ssol.ts` derives it. */
const SOLAYER_VAULT = associatedTokenAccount(SOLAYER_RESTAKING_POOL, SOLAYER_LP_MINT)

/** Anchor discriminators, sha256("global:<name>"), and seen in live transactions on 4 November 2026. */
const RESTAKE = '61a1f1a70620d535'
const UNRESTAKE = '0ab1a1eefa257818'

const SOL_DECIMALS = 9
const SSOL_DECIMALS = 9
const COMPUTE_UNITS = 400_000

/**
 * Restaking asks for a fixed amount, so it must not ask for more than the deposit before it minted.
 * Other deposits landing first move the rate by under a unit, and this margin covers that. It stays
 * in the person's wallet as LP tokens, worth under a millionth of a SOL.
 */
const RESTAKE_MARGIN_UNITS = BigInt(16)

function restakingRule(account: string, prefix: string): InstructionRule {
  return {
    program: SOLAYER_RESTAKING_PROGRAM,
    prefix,
    length: 16,
    accountCount: 10,
    accounts: {
      0: account,
      1: SOLAYER_LP_MINT,
      2: associatedTokenAccount(account, SOLAYER_LP_MINT),
      3: associatedTokenAccount(account, SSOL_MINT),
      4: SSOL_MINT,
      5: SOLAYER_VAULT,
      6: SOLAYER_RESTAKING_POOL,
      7: ASSOCIATED_TOKEN_PROGRAM,
      8: TOKEN_PROGRAM,
      9: SYSTEM_PROGRAM,
    },
    also: ({ data }) => readU64(data, 8) > BigInt(0),
  }
}

export function solayerShapes(account: string): readonly StakeShape[] {
  return [
    {
      rules: [
        createTokenAccountRule(account, SOLAYER_LP_MINT),
        depositSolRule(account, SOLAYER_STAKE_POOL, SOLAYER_LP_MINT),
        restakingRule(account, RESTAKE),
      ],
      also: ([, deposit, restake]) =>
        deposit !== undefined &&
        restake !== undefined &&
        readU64(deposit.data, 9) === readU64(restake.data, 8)
          ? undefined
          : 'This transaction’s restake doesn’t match its deposit.',
    },
    {
      rules: [
        createTokenAccountRule(account, SOLAYER_LP_MINT),
        restakingRule(account, UNRESTAKE),
        createStakeAccountRule(account),
        withdrawStakeRule(account, SOLAYER_STAKE_POOL, SOLAYER_LP_MINT),
        deactivateStakeRule(account),
      ],
      also: ([, unrestake, created, withdrawn, deactivated]) =>
        unrestake !== undefined &&
        created !== undefined &&
        withdrawn !== undefined &&
        deactivated !== undefined &&
        readU64(unrestake.data, 8) === readU64(withdrawn.data, 1) &&
        created.accounts[1] === withdrawn.accounts[4] &&
        created.accounts[1] === deactivated.accounts[0]
          ? undefined
          : 'This transaction’s unstake doesn’t fit together as one exit to your own stake account.',
    },
  ]
}

function restakeInstruction(discriminator: string, account: string, amount: bigint): Instruction {
  return {
    programAddress: SOLAYER_RESTAKING_PROGRAM as Address,
    accounts: [
      signer(account),
      readonly(SOLAYER_LP_MINT),
      writable(associatedTokenAccount(account, SOLAYER_LP_MINT)),
      writable(associatedTokenAccount(account, SSOL_MINT)),
      writable(SSOL_MINT),
      writable(SOLAYER_VAULT),
      readonly(SOLAYER_RESTAKING_POOL),
      readonly(ASSOCIATED_TOKEN_PROGRAM),
      readonly(TOKEN_PROGRAM),
      readonly(SYSTEM_PROGRAM),
    ],
    data: anchorAmountData(discriminator, amount),
  }
}

/** The stake must leave the validator holding it, so this picks the one holding the most. */
export function chooseValidator(
  state: Pick<StakePoolState, 'preferredWithdrawValidator'>,
  validators: readonly PoolValidator[]
): PoolValidator | undefined {
  if (state.preferredWithdrawValidator !== undefined) {
    return validators.find((v) => v.vote === state.preferredWithdrawValidator)
  }
  let best: PoolValidator | undefined
  for (const validator of validators) {
    if (best === undefined || validator.activeLamports > best.activeLamports) best = validator
  }
  return best
}

export interface SolayerOptions {
  env?: Record<string, string | undefined>
  rpc?: SolanaRpc
  /** Names the new stake account's seed. Tests fix it. */
  now?: () => number
}

/** sSOL only: Solayer's sUSD, Pay, card and chain fail the wallet-only test or aren't on this chain. */
export function createSolayerVenue(options: SolayerOptions = {}): ChainVenue {
  const rpc = options.rpc ?? readOnlyRpc(options.env)
  const now = options.now ?? Date.now

  async function readRestakingPoolOrRefuse(): Promise<void> {
    const account = await readAccount(rpc, SOLAYER_RESTAKING_POOL)
    if (account.owner !== SOLAYER_RESTAKING_PROGRAM) {
      throw new ChainActionRefused(
        'Solayer’s restaking pool doesn’t look as expected on chain, so I stopped. Nothing was signed or sent.'
      )
    }
  }

  async function checkedStake(request: ChainActionRequest, account: string) {
    if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
    stakedTokenOrRefuse('Solayer', 'restake', request.tokenIn, 'SOL', 'stake 1 SOL with Solayer')
    const lamports = BigInt(toBaseUnits(request.amount, SOL_DECIMALS))
    const [state] = await Promise.all([
      readStakePool(rpc, 'Solayer', SOLAYER_STAKE_POOL, SOLAYER_LP_MINT),
      readRestakingPoolOrRefuse(),
    ])
    if (state.solDepositAuthority !== undefined) {
      throw new ChainActionRefused(
        'Solayer’s stake pool now needs another signature to deposit SOL, so I stopped. Nothing was signed or sent.'
      )
    }
    const minted = poolTokensForDeposit(state, lamports)
    if (minted <= RESTAKE_MARGIN_UNITS) {
      throw new ChainActionRefused(
        'That amount is too small to give any sSOL. Nothing was signed or sent.'
      )
    }
    return { state, lamports, restaked: minted - RESTAKE_MARGIN_UNITS }
  }

  async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
    const { restaked } = await checkedStake(request, account)
    return {
      receive: { amount: fromBaseUnits(restaked.toString(), SSOL_DECIMALS), symbol: 'sSOL' },
    }
  }

  async function prepareStake(
    request: ChainActionRequest,
    account: string
  ): Promise<PreparedAction> {
    const { state, lamports, restaked } = await checkedStake(request, account)
    const minimum = await readMinimumDelegation(rpc)
    const transaction = await compileForSigning(rpc, account, [
      ...computeBudget(COMPUTE_UNITS),
      createTokenAccount(account, SOLAYER_LP_MINT),
      depositSol({
        pool: SOLAYER_STAKE_POOL,
        state,
        withdrawAuthority: await poolWithdrawAuthority(SOLAYER_STAKE_POOL),
        account,
        lamports,
        minimumPoolTokens: restaked,
      }),
      restakeInstruction(RESTAKE, account, restaked),
    ])
    const receive = fromBaseUnits(restaked.toString(), SSOL_DECIMALS)
    const poolSol = (state.totalLamports / BigInt(1_000_000_000)).toLocaleString('en-US')
    return {
      venueId: 'solayer',
      venueName: 'Solayer',
      kind: 'stake',
      summary: `Restake ${request.amount} SOL with Solayer for about ${receive} sSOL.`,
      pay: { amount: request.amount, symbol: 'SOL' },
      receive: { amount: receive, symbol: 'sSOL', approximate: true },
      notes: [
        `1 sSOL is worth about ${rateText(state.totalLamports, state.poolTokenSupply)} SOL, read from Solayer’s stake pool on chain just now. I’m not showing a yearly rate because the pool doesn’t state one, and rewards aren’t guaranteed.`,
        `Leaving is slow. "unstake" here gives you a stake account of your own, which cools until the Solana epoch ends, about two days at most, and then you withdraw the SOL from it yourself.`,
        `That way out needs at least ${fromBaseUnits(minimum.toString(), SOL_DECIMALS)} SOL worth of sSOL at once, Solana’s minimum for a stake account, read on chain. Below that, your only way out here is selling sSOL on the market, where the price can differ and depth may be thin.`,
        `Solayer has shrunk: its stake pool holds about ${poolSol} SOL on chain, about $10M in November 2026, against a peak of about $520.67M in January 2025. A small pool can mean thin markets for sSOL.`,
        'Solayer’s program can be upgraded by a 3-of-5 multisig. sSOL’s freeze authority is held by that program’s pool, so an upgrade could freeze it. A failure there could lose you money.',
      ],
      signing: { family: 'solana', transaction },
    }
  }

  async function prepareUnstake(
    request: ChainActionRequest,
    account: string
  ): Promise<PreparedAction> {
    if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
    stakedTokenOrRefuse(
      'Solayer',
      'unstake',
      request.tokenIn,
      'sSOL',
      'unstake 1 sSOL from Solayer'
    )
    const poolTokens = BigInt(toBaseUnits(request.amount, SSOL_DECIMALS))

    const [state, rent, minimum] = await Promise.all([
      readStakePool(rpc, 'Solayer', SOLAYER_STAKE_POOL, SOLAYER_LP_MINT),
      readStakeAccountRent(rpc),
      readMinimumDelegation(rpc),
      readRestakingPoolOrRefuse(),
    ])
    const list = await readAccount(rpc, state.validatorList)
    const validators = decodeValidatorList(list.data)
    const validator = validators === undefined ? undefined : chooseValidator(state, validators)
    if (validator === undefined) {
      throw new ChainActionRefused(
        'Solayer’s stake pool has no validator to withdraw from right now. Nothing was signed or sent.'
      )
    }
    const lamports = lamportsForWithdrawal(state, poolTokens, state.stakeWithdrawalFee)
    if (lamports < minimum) {
      throw new ChainActionRefused(
        `This unstake would be worth about ${fromBaseUnits(lamports.toString(), SOL_DECIMALS)} SOL, under the ${fromBaseUnits(minimum.toString(), SOL_DECIMALS)} SOL Solana requires in a stake account. Nothing was signed or sent. Unstake more at once, or sell sSOL on the market instead.`
      )
    }
    if (lamports > validator.activeLamports) {
      throw new ChainActionRefused(
        'That amount can’t be withdrawn from Solayer’s stake pool right now. Nothing was signed or sent. Try a smaller amount.'
      )
    }

    const seed = `intent-${now()}`
    const stakeAccount = addressWithSeed(account, seed, STAKE_PROGRAM)
    const transaction = await compileForSigning(rpc, account, [
      ...computeBudget(COMPUTE_UNITS),
      // Someone who bought sSOL on the market may never have held the LP token this passes through.
      createTokenAccount(account, SOLAYER_LP_MINT),
      restakeInstruction(UNRESTAKE, account, poolTokens),
      createStakeAccountWithSeed(account, seed, rent),
      withdrawStake({
        pool: SOLAYER_STAKE_POOL,
        state,
        withdrawAuthority: await poolWithdrawAuthority(SOLAYER_STAKE_POOL),
        account,
        validatorStake: await validatorStakeAccount(SOLAYER_STAKE_POOL, validator),
        stakeAccount,
        poolTokens,
        minimumLamports: withSlippage(lamports),
      }),
      deactivateStake(account, stakeAccount),
    ])
    const receive = fromBaseUnits(lamports.toString(), SOL_DECIMALS)
    return {
      venueId: 'solayer',
      venueName: 'Solayer',
      kind: 'unstake',
      summary: `Unstake ${request.amount} sSOL from Solayer into a stake account of your own holding about ${receive} SOL, which then cools down before you can withdraw it.`,
      pay: { amount: request.amount, symbol: 'sSOL' },
      receive: { amount: receive, symbol: 'SOL', approximate: true },
      notes: [
        `This exit is delayed. The SOL does not reach your balance now. It goes to a new stake account you control, ${stakeAccount}, which cools until the Solana epoch ends, about two days at most.`,
        'After that you withdraw the SOL from that stake account yourself, using a wallet that manages stake accounts or the Solana command line. That last step isn’t wired here yet, and it needs nobody else’s signature.',
        `The stake pool charges ${feePercentText(state.stakeWithdrawalFee)} on the way out, read on chain, and the amount above is after that fee. About ${fromBaseUnits(rent.toString(), SOL_DECIMALS)} SOL from your wallet funds the stake account, and comes back when you withdraw.`,
      ],
      signing: { family: 'solana', transaction },
    }
  }

  return {
    id: 'solayer',
    name: 'Solayer',
    kinds: ['stake', 'unstake'],
    assertCanFollow: takesOnly('Solayer', ['SOL']),
    quote,
    prepare: (request, account) =>
      request.kind === 'unstake'
        ? prepareUnstake(request, account)
        : request.kind === 'stake'
          ? prepareStake(request, account)
          : Promise.reject(
              new ChainActionRefused(
                `Solayer here can stake and unstake, not ${request.kind}. Nothing was signed or sent.`
              )
            ),
    assertSafe: (payload: SigningPayload, account: string) =>
      assertStakeShape(payload, account, 'Solayer', solayerShapes(account)),
  }
}
