import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  isAddress,
  parseAbi,
  zeroAddress,
  type Address,
} from 'viem'

import {
  ChainActionRefused,
  quotedApy,
  takesOnly,
  toBaseUnits,
  tokenBySymbol,
  type ChainActionRequest,
  type ChainVenue,
  type PreparedAction,
  type VenuePosition,
  type VenueQuote,
} from '../types'
import { AAVE_MONAD_MARKET, readReserve } from './aave'
import {
  approvalNote,
  buildEvmCall,
  evmCallVenueParts,
  type CheckContext,
  type DecodedCall,
  type EvmCallPolicy,
  type EvmReaderClient,
} from './call'
import { evmReader, type EvmClient } from './client'
import { sameAddress } from './submit'
import { MONAD_TOKENS } from './tokens'

// Vault aavev3-monad-usdc in Beefy's registry, beefyfinance/beefy-v2 src/config/vault/monad.json. On
// chain: a minimal proxy of BeefyVaultV7 (verified on Monadscan), whose want() is this USDC, and
// whose balance() held about $3.01M when reviewed in November 2026. The strategy is what strategy()
// returned then, a StrategyAaveSupplyOnly whose vault() is this vault, into Aave's USDC aToken as
// bgd-labs/aave-address-book AaveV3Monad.sol lists it.
export const BEEFY_MONAD_VAULT = '0xb3e09fb538186983661f1c581B3eDc2778d24EF8'
export const BEEFY_MONAD_STRATEGY = '0x6105E2bF96283800781d31C6Ad18c6FBBde688CD'
export const BEEFY_MONAD_USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'

const NAME = 'Beefy'
const VAULT_NAME = "Beefy's Aave USDC vault on Monad"
const USDC_DECIMALS = 6
const RATE_URL = 'https://api.beefy.finance/apy/breakdown'
const RATE_VAULT_ID = 'aavev3-monad-usdc'
const RATE_TIMEOUT_MS = 5_000

const CALL_ABI = parseAbi([
  'function deposit(uint256 amount)',
  'function withdraw(uint256 shares)',
  'function withdrawAll()',
])

const VAULT_READ_ABI = parseAbi([
  'function want() view returns (address)',
  'function strategy() view returns (address)',
  'function stratCandidate() view returns (address implementation, uint256 proposedTime)',
  'function balance() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
])

const STRATEGY_READ_ABI = parseAbi(['function paused() view returns (bool)'])

function refuse(reason: string): never {
  throw new ChainActionRefused(`${reason} Nothing was signed or sent.`)
}

/** A read this needs that fails stops the build: it decides whether the person's money is safe to move. */
async function orRefuse<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof ChainActionRefused) throw error
    return refuse(`I couldn't read ${NAME}'s vault just now, so this was not built.`)
  }
}

/** No call names an address: the vault takes from, credits and pays only whoever sends it. */
function checkCall(call: DecodedCall, { account, approval }: CheckContext): void {
  if (!isAddress(account)) refuse('That is not a Monad address.')
  if (call.functionName === 'withdrawAll') {
    if (approval !== undefined) refuse('A withdrawal needs no approval.')
    return
  }
  const [amount] = call.args as readonly [bigint]
  if (call.functionName === 'deposit') {
    if (amount === BigInt(0)) refuse('This deposit is empty.')
    if (approval !== undefined && approval.units !== amount) {
      refuse('This approval does not match the deposit.')
    }
    return
  }
  if (call.functionName === 'withdraw') {
    if (amount === BigInt(0)) refuse('This withdrawal is empty.')
    if (approval !== undefined) refuse('A withdrawal needs no approval.')
    return
  }
  refuse(`This transaction does something I haven't confirmed for ${NAME}.`)
}

export const BEEFY_MONAD_POLICY: EvmCallPolicy = {
  venueName: NAME,
  chain: 'monad',
  contracts: {
    [BEEFY_MONAD_VAULT]: {
      abi: CALL_ABI,
      functions: ['deposit', 'withdraw', 'withdrawAll'],
      check: checkCall,
    },
  },
  spenders: [BEEFY_MONAD_VAULT],
  approvable: [BEEFY_MONAD_USDC],
}

function usdcUnits(request: ChainActionRequest, account: string): bigint {
  if (!isAddress(account)) refuse('That is not a Monad address.')
  const token = tokenBySymbol(MONAD_TOKENS, request.tokenIn)
  if (token === undefined || !sameAddress(token.id, BEEFY_MONAD_USDC)) {
    refuse(`${NAME} takes USDC here, not ${request.tokenIn}. Try "supply 10 USDC on ${NAME}".`)
  }
  if (request.recipient !== undefined && !sameAddress(request.recipient, account)) {
    refuse(`${NAME} only pays the wallet that signs, so this can't go to another address.`)
  }
  return BigInt(toBaseUnits(request.amount, USDC_DECIMALS))
}

function usdc(units: bigint): string {
  return formatUnits(units, USDC_DECIMALS)
}

function readVault<
  const F extends 'want' | 'strategy' | 'stratCandidate' | 'balance' | 'totalSupply',
>(reader: EvmReaderClient, functionName: F) {
  return reader.readContract({ address: BEEFY_MONAD_VAULT, abi: VAULT_READ_ABI, functionName })
}

/**
 * Beefy's own figures, for the rate only, so anything odd here means no rate and never stops a build.
 * Aave's lending rate is the base, and what Beefy adds by compounding rewards is the reward part.
 */
async function readApy(fetcher: typeof fetch): Promise<PreparedAction['apy']> {
  try {
    const response = await fetcher(RATE_URL, {
      signal: AbortSignal.timeout(RATE_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!response.ok) return undefined
    const rates = (await response.json()) as Record<
      string,
      { totalApy?: unknown; lendingApr?: unknown } | undefined
    >
    const { totalApy: total, lendingApr: base } = rates[RATE_VAULT_ID] ?? {}
    if (typeof total !== 'number' || typeof base !== 'number') return undefined
    if (!(base >= 0 && base <= total && total <= 1)) return undefined
    const percent = (fraction: number): number => Math.round(fraction * 10_000) / 100
    const reward = percent(total - base)
    return { basePercent: percent(base), ...(reward > 0 ? { rewardPercent: reward } : {}) }
  } catch {
    return undefined
  }
}

/** A new strategy blocks new money until it is reviewed. It never blocks a withdrawal. */
async function assertTakingDeposits(reader: EvmReaderClient): Promise<void> {
  const [want, strategy, [candidate], paused] = await orRefuse(() =>
    Promise.all([
      readVault(reader, 'want'),
      readVault(reader, 'strategy'),
      readVault(reader, 'stratCandidate'),
      reader.readContract({
        address: BEEFY_MONAD_STRATEGY,
        abi: STRATEGY_READ_ABI,
        functionName: 'paused',
      }),
    ])
  )
  if (!sameAddress(want, BEEFY_MONAD_USDC)) refuse(`${VAULT_NAME} no longer takes USDC.`)
  if (!sameAddress(strategy, BEEFY_MONAD_STRATEGY)) {
    refuse(
      `${NAME} moved this vault to a strategy I haven't confirmed, so new deposits stay blocked until it is checked. Withdrawals still work.`
    )
  }
  if (!sameAddress(candidate, zeroAddress)) {
    refuse(
      `${NAME} has proposed a new strategy for this vault, so new deposits stay blocked until it is checked. Withdrawals still work.`
    )
  }
  if (paused) refuse(`${VAULT_NAME} isn't taking deposits right now. Withdrawals still work.`)
}

const PAYS_WHAT_IT_RETURNS =
  'Share value can go down as well as up. A withdrawal pays what the strategy returns, which can be less than you put in if the strategy or Aave takes a loss.'
const AAVE_LIQUIDITY =
  "If Aave's USDC is fully lent out, a withdrawal can fail until borrowers repay or new lenders arrive."

const SUPPLY_NOTES = [
  `${NAME} lends this USDC on Aave V3 on Monad and reinvests the rewards for you.`,
  PAYS_WHAT_IT_RETURNS,
  "This rate is not guaranteed. Aave's part moves with borrowing demand, and the reward part stops if the rewards do.",
  `There is no lockup, and no deposit or withdrawal fee. ${AAVE_LIQUIDITY} ${NAME} keeps 9.5% of the rewards it harvests.`,
  "You get mooAaveV3MonadUSDC shares, and your wallet may show a very small number of them. The token is marked as 18 decimals but its amounts are USDC-sized, so that doesn't mean your money is gone.",
  `${NAME}'s admins hold real power here. After a 6-hour delay they can move this vault to a new strategy or replace the current strategy's code, and a bad change could lose your deposit. A keeper can pause new deposits at any time, which doesn't stop withdrawals.`,
  `This vault opened in July 2026. DefiLlama lists no exploit of ${NAME} as of November 2026. It does list an $862,000 oracle loss on Aave V3 on Ethereum in March 2026, a different market from this one. Neither fact rules out a contract bug here.`,
]

async function prepareSupply(
  request: ChainActionRequest,
  account: string,
  reader: EvmReaderClient,
  fetcher: typeof fetch
): Promise<PreparedAction> {
  const units = usdcUnits(request, account)
  await assertTakingDeposits(reader)

  const [held, vaultBalance, totalSupply] = await orRefuse(() =>
    Promise.all([
      reader.readContract({
        address: BEEFY_MONAD_USDC,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account as Address],
      }),
      readVault(reader, 'balance'),
      readVault(reader, 'totalSupply'),
    ])
  )
  if (held < units) refuse(`You hold ${usdc(held)} USDC, which is less than ${request.amount}.`)
  if (vaultBalance > BigInt(0) && (units * totalSupply) / vaultBalance === BigInt(0)) {
    refuse('This amount is too small to deposit. Try a larger one.')
  }

  const { signing, needsApproval } = await orRefuse(() =>
    buildEvmCall(
      {
        chain: 'monad',
        account,
        to: BEEFY_MONAD_VAULT,
        data: encodeFunctionData({ abi: CALL_ABI, functionName: 'deposit', args: [units] }),
        pull: { token: BEEFY_MONAD_USDC, spender: BEEFY_MONAD_VAULT, units },
      },
      reader
    )
  )
  return {
    venueId: 'beefy-monad',
    venueName: NAME,
    kind: 'supply',
    summary: `Supply ${request.amount} USDC to ${VAULT_NAME}.`,
    pay: { amount: request.amount, symbol: 'USDC' },
    apy: await readApy(fetcher),
    notes: [
      ...SUPPLY_NOTES,
      ...(needsApproval ? [approvalNote(NAME, request.amount, 'USDC')] : []),
    ],
    signing,
  }
}

async function prepareWithdraw(
  request: ChainActionRequest,
  account: string,
  reader: EvmReaderClient
): Promise<PreparedAction> {
  const units = usdcUnits(request, account)
  const whole = request.wholePosition === true

  const [want, vaultBalance, totalSupply, shares] = await orRefuse(() =>
    Promise.all([
      readVault(reader, 'want'),
      readVault(reader, 'balance'),
      readVault(reader, 'totalSupply'),
      reader.readContract({
        address: BEEFY_MONAD_VAULT,
        abi: VAULT_READ_ABI,
        functionName: 'balanceOf',
        args: [account as Address],
      }),
    ])
  )
  if (!sameAddress(want, BEEFY_MONAD_USDC)) refuse(`${VAULT_NAME} no longer pays USDC.`)
  if (shares === BigInt(0) || totalSupply === BigInt(0) || vaultBalance === BigInt(0)) {
    refuse(`You have no USDC in ${VAULT_NAME}.`)
  }
  const worth = (shares * vaultBalance) / totalSupply
  if (!whole && units > worth) {
    refuse(`You have about ${usdc(worth)} USDC in ${VAULT_NAME}. Try that amount or less.`)
  }

  // Rounded up, so the shares pay at least what was typed. Since units <= worth, this can't pass shares.
  const burn = whole ? shares : (units * totalSupply + vaultBalance - BigInt(1)) / vaultBalance
  const paid = (burn * vaultBalance) / totalSupply

  await assertAaveCanPay(paid, reader)

  const { signing } = await orRefuse(() =>
    buildEvmCall(
      {
        chain: 'monad',
        account,
        to: BEEFY_MONAD_VAULT,
        data: whole
          ? encodeFunctionData({ abi: CALL_ABI, functionName: 'withdrawAll' })
          : encodeFunctionData({ abi: CALL_ABI, functionName: 'withdraw', args: [burn] }),
      },
      reader
    ).catch((error: unknown) => {
      if (!(error instanceof ChainActionRefused)) throw error
      return refuse(
        `This would fail on the chain right now: ${VAULT_NAME} wouldn't pay this out. Your shares are still yours. Try a smaller amount or try later, and check you have enough for the network fee.`
      )
    })
  )
  const shown = whole ? usdc(worth) : request.amount
  return {
    venueId: 'beefy-monad',
    venueName: NAME,
    kind: 'withdraw',
    summary: whole
      ? `Withdraw all of your USDC, about ${shown}, from ${VAULT_NAME}.`
      : `Withdraw ${request.amount} USDC from ${VAULT_NAME}.`,
    pay: { amount: shown, symbol: 'USDC' },
    receive: { amount: usdc(paid), symbol: 'USDC', approximate: true },
    notes: [
      PAYS_WHAT_IT_RETURNS,
      AAVE_LIQUIDITY,
      whole
        ? 'This cashes in every share you hold, so nothing stays behind.'
        : 'Earnings keep adding to what you hold here, so a small amount can stay behind after you withdraw what you saw as your full balance.',
    ],
    signing,
  }
}

/**
 * This vault pays by taking USDC back out of Aave, so Aave pausing it or running short stops the
 * exit here too. A way out must not depend on these reads: if one fails, trying the call decides.
 */
async function assertAaveCanPay(paid: bigint, reader: EvmReaderClient): Promise<void> {
  const token = AAVE_MONAD_MARKET.tokens.find((t) => sameAddress(t.id, BEEFY_MONAD_USDC))
  if (token === undefined) return
  const reserve = await readReserve(AAVE_MONAD_MARKET, token, reader).catch(() => undefined)
  if (reserve === undefined) return
  if (reserve.paused || !reserve.active) {
    refuse(
      `Aave, where ${VAULT_NAME} lends, has paused USDC right now, so nothing can come out until it reopens. Your shares are still yours.`
    )
  }
  if (paid > reserve.free) {
    refuse(
      `Aave, where ${VAULT_NAME} lends, has only about ${usdc(reserve.free)} USDC free right now, because the rest is lent out. Your shares are still yours. Try a smaller amount, or try later.`
    )
  }
}

/** All three from one block. A failed read throws, since empty would say nothing is here. */
async function readPositions(account: string, reader: EvmReaderClient): Promise<VenuePosition[]> {
  if (!isAddress(account)) refuse('That is not a Monad address.')
  const vault = { address: BEEFY_MONAD_VAULT, abi: VAULT_READ_ABI } as const
  const [shares, vaultBalance, totalSupply] = await reader.multicall({
    allowFailure: false,
    contracts: [
      { ...vault, functionName: 'balanceOf', args: [account] },
      { ...vault, functionName: 'balance' },
      { ...vault, functionName: 'totalSupply' },
    ],
  })
  if (shares === BigInt(0) || totalSupply === BigInt(0)) return []
  const worth = (shares * vaultBalance) / totalSupply
  return worth === BigInt(0) ? [] : [{ slot: 'supplied', symbol: 'USDC', amount: usdc(worth) }]
}

/** Reads go through `getReader`, so a venue built at import doesn't open a client until it is used. */
export function createBeefyMonadVenue(
  getReader: () => EvmReaderClient = () => evmReader('monad'),
  client?: EvmClient,
  fetcher: typeof fetch = fetch
): ChainVenue {
  const quote = async (request: ChainActionRequest, account: string): Promise<VenueQuote> => {
    if (request.kind !== 'supply') refuse(`${NAME} only gives a rate for a supply.`)
    usdcUnits(request, account)
    await assertTakingDeposits(getReader())
    return quotedApy(await readApy(fetcher))
  }

  const prepare = (request: ChainActionRequest, account: string): Promise<PreparedAction> => {
    if (request.kind === 'supply') return prepareSupply(request, account, getReader(), fetcher)
    if (request.kind === 'withdraw') return prepareWithdraw(request, account, getReader())
    return Promise.reject(
      new ChainActionRefused(
        `${NAME} supplies and withdraws USDC here, and doesn't ${request.kind}. Nothing was signed or sent.`
      )
    )
  }

  return {
    id: 'beefy-monad',
    name: NAME,
    kinds: ['supply', 'withdraw'],
    assertCanFollow: takesOnly(NAME, ['USDC']),
    quote,
    prepare,
    positions: (account) => readPositions(account, getReader()),
    ...evmCallVenueParts(BEEFY_MONAD_POLICY, client),
  }
}

export const beefyMonadVenue = createBeefyMonadVenue()
