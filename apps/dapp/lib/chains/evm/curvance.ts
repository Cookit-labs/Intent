import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  isAddress,
  maxUint256,
  parseAbi,
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

// The "WMON | USDC" market at https://docs.curvance.com/app/protocol-overview/monad-contract-addresses.md,
// and in npm curvance@5.11.1 contracts/monad-mainnet.json. On chain: cUSDC.asset() is CURVANCE_USDC,
// cUSDC.marketManager() is this manager, and manager.isListed(cUSDC) is true. Curvance's other USDC
// markets each have their own cUSDC, and are refused here.
export const CURVANCE_CUSDC = '0x8EE9FC28B8Da872c38A496e9dDB9700bb7261774'
export const CURVANCE_MARKET_MANAGER = '0xa6A2A92F126b79Ee0804845ee6B52899b4491093'
export const CURVANCE_USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'

const NAME = 'Curvance'
const MARKET = 'WMON | USDC'
const USDC_DECIMALS = 6
const SECONDS_PER_YEAR = 31_536_000
/** MarketManagerIsolated.MIN_HOLD_PERIOD, a constant. Posting collateral or borrowing starts it. */
const HOLD_SECONDS = BigInt(1200)
/** The manager stores pause flags as 1 for off and 2 for on. */
const NOT_PAUSED = 1
const WAD = BigInt(10) ** BigInt(18)

const CALL_ABI = parseAbi([
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)',
])

const CTOKEN_READ_ABI = parseAbi([
  // Not marked view on chain, since it accrues first. Asked with eth_call, nothing is written, and
  // it is the live rate: `convertToAssets` holds to the last accrual, which runs a little behind.
  'function exchangeRateUpdated() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function collateralPosted(address account) view returns (uint256)',
  'function previewDeposit(uint256 assets) view returns (uint256)',
  'function previewWithdraw(uint256 assets) view returns (uint256)',
  'function assetsHeld() view returns (uint256)',
  'function marketOutstandingDebt() view returns (uint256)',
  'function interestFee() view returns (uint16)',
  'function IRM() view returns (address)',
])

const MANAGER_READ_ABI = parseAbi([
  'function isListed(address cToken) view returns (bool)',
  'function actionsPaused(address cToken) view returns (bool mintPaused, bool collateralizationPaused, bool borrowPaused)',
  'function redeemPaused() view returns (uint8)',
  'function accountAssets(address account) view returns (uint256 cooldownTimestamp)',
])

const IRM_READ_ABI = parseAbi([
  'function supplyRate(uint256 assetsHeld, uint256 debt, uint256 interestFee) view returns (uint256)',
])

function refuse(reason: string): never {
  throw new ChainActionRefused(`${reason} Nothing was signed or sent.`)
}

/** A read this needs that fails stops the build: it decides whether the person's money is safe to move. */
async function orRefuse<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof ChainActionRefused) throw error
    return refuse(`I couldn't read ${NAME}'s market just now, so this was not built.`)
  }
}

function checkCall(call: DecodedCall, { account, approval }: CheckContext): void {
  if (call.functionName === 'deposit') {
    const [assets, receiver] = call.args as readonly [bigint, string]
    if (!sameAddress(receiver, account)) refuse('This deposit credits someone else.')
    if (assets === BigInt(0)) refuse('This deposit is empty.')
    if (approval !== undefined && approval.units !== assets) {
      refuse('This approval does not match the deposit.')
    }
    return
  }
  if (call.functionName === 'withdraw' || call.functionName === 'redeem') {
    const [amount, receiver, owner] = call.args as readonly [bigint, string, string]
    if (!sameAddress(receiver, account)) refuse('This withdrawal pays someone else.')
    if (!sameAddress(owner, account)) refuse("This withdrawal takes someone else's deposit.")
    if (amount === BigInt(0)) refuse('This withdrawal is empty.')
    if (amount === maxUint256) refuse('This withdrawal doesn’t name an amount.')
    if (approval !== undefined) refuse('A withdrawal needs no approval.')
    return
  }
  refuse(`This transaction does something I haven't confirmed for ${NAME}.`)
}

export const CURVANCE_POLICY: EvmCallPolicy = {
  venueName: NAME,
  chain: 'monad',
  contracts: {
    [CURVANCE_CUSDC]: {
      abi: CALL_ABI,
      functions: ['deposit', 'withdraw', 'redeem'],
      check: checkCall,
    },
  },
  spenders: [CURVANCE_CUSDC],
  approvable: [CURVANCE_USDC],
}

function usdcUnits(request: ChainActionRequest, account: string): bigint {
  if (!isAddress(account)) refuse('That is not a Monad address.')
  const token = tokenBySymbol(MONAD_TOKENS, request.tokenIn)
  if (token === undefined || !sameAddress(token.id, CURVANCE_USDC)) {
    refuse(`${NAME} takes USDC here, not ${request.tokenIn}. Try "supply 10 USDC on ${NAME}".`)
  }
  return BigInt(toBaseUnits(request.amount, USDC_DECIMALS))
}

function usdc(units: bigint): string {
  return formatUnits(units, USDC_DECIMALS)
}

interface Liquidity {
  held: bigint
  debt: bigint
}

function readLiquidity(reader: EvmReaderClient): Promise<Liquidity> {
  return Promise.all([
    reader.readContract({
      address: CURVANCE_CUSDC,
      abi: CTOKEN_READ_ABI,
      functionName: 'assetsHeld',
    }),
    reader.readContract({
      address: CURVANCE_CUSDC,
      abi: CTOKEN_READ_ABI,
      functionName: 'marketOutstandingDebt',
    }),
  ]).then(([held, debt]) => ({ held, debt }))
}

/**
 * The rate lenders earn, as Curvance's own SDK derives it: the model's per-second rate in WAD, after
 * the fee, times a year. The model is read from the market each time, since admins can replace it.
 * Rewards aren't on chain here, so they are not counted. Unreadable means no rate.
 */
async function readApy(reader: EvmReaderClient): Promise<PreparedAction['apy']> {
  try {
    const [{ held, debt }, fee, irm] = await Promise.all([
      readLiquidity(reader),
      reader.readContract({
        address: CURVANCE_CUSDC,
        abi: CTOKEN_READ_ABI,
        functionName: 'interestFee',
      }),
      reader.readContract({ address: CURVANCE_CUSDC, abi: CTOKEN_READ_ABI, functionName: 'IRM' }),
    ])
    const perSecond = await reader.readContract({
      address: irm,
      abi: IRM_READ_ABI,
      functionName: 'supplyRate',
      args: [held, debt, BigInt(fee)],
    })
    const percent = (Number(perSecond) * SECONDS_PER_YEAR) / 1e16
    if (!Number.isFinite(percent) || percent < 0) return undefined
    return { basePercent: Math.round(percent * 100) / 100 }
  } catch {
    return undefined
  }
}

async function assertTakingDeposits(reader: EvmReaderClient): Promise<void> {
  const [listed, [mintPaused]] = await orRefuse(() =>
    Promise.all([
      reader.readContract({
        address: CURVANCE_MARKET_MANAGER,
        abi: MANAGER_READ_ABI,
        functionName: 'isListed',
        args: [CURVANCE_CUSDC],
      }),
      reader.readContract({
        address: CURVANCE_MARKET_MANAGER,
        abi: MANAGER_READ_ABI,
        functionName: 'actionsPaused',
        args: [CURVANCE_CUSDC],
      }),
    ])
  )
  if (!listed || mintPaused) refuse(`${NAME}'s ${MARKET} market isn't taking deposits right now.`)
}

function freeNote(liquidity: Liquidity | undefined): string {
  if (liquidity === undefined) {
    return 'Most of a lending market is lent out, so a withdrawal can fail until borrowers repay or new lenders arrive.'
  }
  const { held, debt } = liquidity
  const total = held + debt
  const lent = total === BigInt(0) ? BigInt(0) : (debt * BigInt(100)) / total
  return `About ${held / BigInt(10 ** USDC_DECIMALS)} USDC of this market can be withdrawn right now, and ${lent}% is lent out. A withdrawal larger than what is free fails until borrowers repay or new lenders arrive.`
}

const SUPPLY_NOTES = [
  `This lends into ${NAME}'s ${MARKET} market only, where borrowers post WMON. If WMON falls faster than loans can be liquidated, or a price feed fails, the bad debt comes off what USDC lenders here hold.`,
  'This rate is not guaranteed. It moves with borrowing demand, and it counts no rewards.',
  `There is no hold on this deposit, because it isn't posted as collateral. If you post collateral or borrow in this market in ${NAME}'s own app, withdrawals stop for 20 minutes after each time.`,
  "These market contracts aren't behind an upgrade proxy, but admins hold real power over them. One signer on Curvance's rapid-response multisig can pause withdrawals across its markets, and you couldn't get out until they are unpaused. Its timelock and 4-of-5 emergency council can replace this market's rate model and raise the share of interest it keeps, up to 60%.",
  'Curvance has been audited by Trail of Bits, Cantina, Sherlock and TrustSec, and DefiLlama lists no exploit of it as of November 2026. That lowers the risk of a contract bug but does not remove it.',
]

async function prepareSupply(
  request: ChainActionRequest,
  account: string,
  reader: EvmReaderClient
): Promise<PreparedAction> {
  const units = usdcUnits(request, account)
  await assertTakingDeposits(reader)

  const [balance, shares] = await orRefuse(() =>
    Promise.all([
      reader.readContract({
        address: CURVANCE_USDC,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account as Address],
      }),
      reader.readContract({
        address: CURVANCE_CUSDC,
        abi: CTOKEN_READ_ABI,
        functionName: 'previewDeposit',
        args: [units],
      }),
    ])
  )
  if (balance < units) {
    refuse(`You hold ${usdc(balance)} USDC, which is less than ${request.amount}.`)
  }
  if (shares === BigInt(0)) refuse('This amount is too small to deposit. Try a larger one.')

  const { signing, needsApproval } = await orRefuse(() =>
    buildEvmCall(
      {
        chain: 'monad',
        account,
        to: CURVANCE_CUSDC,
        data: encodeFunctionData({
          abi: CALL_ABI,
          functionName: 'deposit',
          args: [units, account as Address],
        }),
        pull: { token: CURVANCE_USDC, spender: CURVANCE_CUSDC, units },
      },
      reader
    )
  )
  const [apy, liquidity] = await Promise.all([
    readApy(reader),
    readLiquidity(reader).catch(() => undefined),
  ])
  return {
    venueId: 'curvance',
    venueName: NAME,
    kind: 'supply',
    summary: `Supply ${request.amount} USDC to ${NAME}'s ${MARKET} market.`,
    pay: { amount: request.amount, symbol: 'USDC' },
    receive: { amount: usdc(shares), symbol: 'cUSDC', approximate: true },
    apy,
    notes: [
      ...SUPPLY_NOTES.slice(0, 2),
      freeNote(liquidity),
      ...SUPPLY_NOTES.slice(2),
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
  const owner = account as Address
  const whole = request.wholePosition === true

  const [listed, redeemPaused, cooldown, block, balance, posted, shares, liquidity, rate] =
    await orRefuse(() =>
      Promise.all([
        reader.readContract({
          address: CURVANCE_MARKET_MANAGER,
          abi: MANAGER_READ_ABI,
          functionName: 'isListed',
          args: [CURVANCE_CUSDC],
        }),
        reader.readContract({
          address: CURVANCE_MARKET_MANAGER,
          abi: MANAGER_READ_ABI,
          functionName: 'redeemPaused',
        }),
        reader.readContract({
          address: CURVANCE_MARKET_MANAGER,
          abi: MANAGER_READ_ABI,
          functionName: 'accountAssets',
          args: [owner],
        }),
        reader.getBlock(),
        reader.readContract({
          address: CURVANCE_CUSDC,
          abi: CTOKEN_READ_ABI,
          functionName: 'balanceOf',
          args: [owner],
        }),
        reader.readContract({
          address: CURVANCE_CUSDC,
          abi: CTOKEN_READ_ABI,
          functionName: 'collateralPosted',
          args: [owner],
        }),
        reader.readContract({
          address: CURVANCE_CUSDC,
          abi: CTOKEN_READ_ABI,
          functionName: 'previewWithdraw',
          args: [units],
        }),
        readLiquidity(reader),
        reader.readContract({
          address: CURVANCE_CUSDC,
          abi: CTOKEN_READ_ABI,
          functionName: 'exchangeRateUpdated',
        }),
      ])
    )

  if (!listed || redeemPaused !== NOT_PAUSED) {
    refuse(
      `Withdrawals from ${NAME}'s ${MARKET} market are paused right now, so nothing can come out until they reopen. What you lent there is still yours.`
    )
  }
  const holdEnds = cooldown + HOLD_SECONDS
  if (holdEnds > block.timestamp) {
    const minutes = (holdEnds - block.timestamp + BigInt(59)) / BigInt(60)
    refuse(
      `${NAME} is holding this account for about ${minutes} minutes, because collateral was posted or a loan was taken in this market. Try again after that.`
    )
  }
  if (balance === BigInt(0)) refuse(`You have no USDC lent in ${NAME}'s ${MARKET} market.`)

  // Past the idle shares the contract takes posted collateral instead, which can weaken a loan.
  const idle = balance > posted ? balance - posted : BigInt(0)
  // A whole exit names the shares, so `shares`, worked out from the figure shown, plays no part.
  if (whole ? posted > BigInt(0) : shares > idle) {
    const free = (idle * rate) / WAD
    refuse(
      posted > BigInt(0)
        ? `About ${usdc(free)} USDC of yours can be withdrawn here without touching the collateral you posted. Try that amount or less, or remove the collateral in ${NAME}'s own app first.`
        : `You have about ${usdc(free)} USDC in ${NAME}'s ${MARKET} market. Try that amount or less.`
    )
  }
  const worth = (balance * rate) / WAD
  const taken = whole ? worth : units
  if (taken > liquidity.held) {
    refuse(
      `This market has only ${usdc(liquidity.held)} USDC free right now, because the rest is lent out. Try a smaller amount, or try later.`
    )
  }

  const { signing } = await orRefuse(() =>
    buildEvmCall(
      {
        chain: 'monad',
        account,
        to: CURVANCE_CUSDC,
        // Shares don't accrue, so redeeming all of them leaves nothing, whatever interest has added.
        data: whole
          ? encodeFunctionData({
              abi: CALL_ABI,
              functionName: 'redeem',
              args: [balance, owner, owner],
            })
          : encodeFunctionData({
              abi: CALL_ABI,
              functionName: 'withdraw',
              args: [units, owner, owner],
            }),
      },
      reader
    ).catch((error: unknown) => {
      if (!(error instanceof ChainActionRefused)) throw error
      return refuse(
        `This would fail on the chain right now: ${NAME} wouldn't pay this out. What you lent there is still yours. Try a smaller amount or try later, and check you have enough for the network fee.`
      )
    })
  )
  const shown = whole ? usdc(worth) : request.amount
  return {
    venueId: 'curvance',
    venueName: NAME,
    kind: 'withdraw',
    summary: whole
      ? `Withdraw all of your USDC, about ${shown}, from ${NAME}'s ${MARKET} market.`
      : `Withdraw ${request.amount} USDC from ${NAME}'s ${MARKET} market.`,
    pay: { amount: shown, symbol: 'USDC' },
    ...(whole ? { receive: { amount: shown, symbol: 'USDC', approximate: true } } : {}),
    notes: [
      'This takes only what you lent. Anything you posted as collateral in this market stays posted.',
      freeNote(liquidity),
      whole
        ? 'This cashes in every share you hold, so nothing stays behind. What you get is what those shares are worth when this lands.'
        : 'Interest keeps adding to what you hold here, so a small amount can stay behind after you withdraw what you saw as your full balance.',
    ],
    signing,
  }
}

/**
 * Everything here, posted collateral included: it is the person's money, even if a withdraw has to
 * wait for it to come off. A failed read throws, since empty would say nothing is here.
 */
async function readPositions(account: string, reader: EvmReaderClient): Promise<VenuePosition[]> {
  if (!isAddress(account)) refuse('That is not a Monad address.')
  const [shares, rate] = await reader.multicall({
    allowFailure: false,
    contracts: [
      {
        address: CURVANCE_CUSDC,
        abi: CTOKEN_READ_ABI,
        functionName: 'balanceOf',
        args: [account],
      },
      { address: CURVANCE_CUSDC, abi: CTOKEN_READ_ABI, functionName: 'exchangeRateUpdated' },
    ],
  })
  const worth = (shares * rate) / WAD
  return worth === BigInt(0) ? [] : [{ slot: 'supplied', symbol: 'USDC', amount: usdc(worth) }]
}

/** Reads go through `getReader`, so a venue built at import doesn't open a client until it is used. */
export function createCurvanceVenue(
  getReader: () => EvmReaderClient = () => evmReader('monad'),
  client?: EvmClient
): ChainVenue {
  const quote = async (request: ChainActionRequest, account: string): Promise<VenueQuote> => {
    if (request.kind !== 'supply') refuse(`${NAME} only gives a rate for a supply.`)
    usdcUnits(request, account)
    const reader = getReader()
    await assertTakingDeposits(reader)
    return quotedApy(await readApy(reader))
  }

  const prepare = (request: ChainActionRequest, account: string): Promise<PreparedAction> => {
    if (request.kind === 'supply') return prepareSupply(request, account, getReader())
    if (request.kind === 'withdraw') return prepareWithdraw(request, account, getReader())
    return Promise.reject(
      new ChainActionRefused(
        `${NAME} supplies and withdraws USDC here, and doesn't ${request.kind}. Nothing was signed or sent.`
      )
    )
  }

  return {
    id: 'curvance',
    name: NAME,
    kinds: ['supply', 'withdraw'],
    assertCanFollow: takesOnly(NAME, ['USDC']),
    quote,
    prepare,
    positions: (account) => readPositions(account, getReader()),
    ...evmCallVenueParts(CURVANCE_POLICY, client),
  }
}

export const curvanceVenue = createCurvanceVenue()
