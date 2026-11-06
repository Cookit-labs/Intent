import { Transaction } from '@mysten/sui/transactions'
import { normalizeSuiAddress } from '@mysten/sui/utils'

import type {
  ChainActionRequest,
  ChainVenue,
  PreparedAction,
  SigningPayload,
  VenueQuote,
} from '../types'
import { assertSuiAccount } from './client'
import {
  bridgeNote,
  CLOCK,
  CLOCK_SHARED_VERSION,
  dataOf,
  judgeFill,
  LIVE_SWAP_IO,
  literalBool,
  literalU64,
  minimumOut,
  moveCallsNamed,
  pairTokens,
  readOrRefuse,
  refuse,
  resultOf,
  sameType,
  sharedObjectId,
  slippageNote,
  tokenType,
  u128At,
  u64At,
  unspentNote,
  type Fill,
  type SwapIo,
} from './direct-swap'
import { assertPtbSafe, moveTarget, type PtbPolicy } from './safety'
import { displayAmount } from './tokens'

/**
 * Momentum's latest CLMM package, version 5. Its docs (mmt-finance/docs,
 * clmm-smart-contracts/deployments) and @mmt-finance/clmm-sdk 1.3.25 both list it, the Move Registry's
 * @mmt/clmm-core resolves to it, and on chain the UpgradeCap 0x59d16188...dcb4 names it. The docs
 * label it `ClmmPublishedAt` and the SDK `packageId`. The other id they list, 0x70285592...b860, is
 * version 1, where the types were defined, so it is not the one to call.
 */
export const MOMENTUM_PACKAGE = '0xcf60a40f45d46fc1e828871a647c1e25a0915dec860d2662eb10fdb382c3c1d1'

/** `Version` in the same table and `versionId` in the SDK. On chain, a `version::Version`. */
export const MOMENTUM_VERSION = '0x2375a0b1ec12010aaea3b2545acfa2ad34cfbba03ce4b59f4c39e1e25eed1b2a'
const VERSION_SHARED_VERSION = 499761252

export interface MomentumPool {
  id: string
  initialSharedVersion: number
  x: string
  y: string
}

/**
 * "SUI-suiUSDC" and "USDT-USDC" in the docs' pool table. On chain each is a `pool::Pool<X, Y>` of
 * these coins. USDT-USDC is the deeper and cheaper of its two listed tiers. SUI-suiUSDT is left out:
 * a 10 SUI read found about $0.01 of depth. There is no USDsui pool.
 */
export const MOMENTUM_POOLS: readonly MomentumPool[] = [
  {
    id: '0x455cf8d2ac91e7cb883f515874af750ed3cd18195c970b7a2d46235ac2b0c388',
    initialSharedVersion: 499761256,
    x: 'SUI',
    y: 'USDC',
  },
  {
    id: '0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9',
    initialSharedVersion: 609810806,
    x: 'USDT',
    y: 'USDC',
  },
]

/**
 * The widest limits `trade::flash_swap` takes, from the SDK's `swapV2`. Price protection is the
 * minimum below, not the limit: at a price limit the pool would stop part way and fill less.
 */
const LOWEST_SQRT_PRICE = BigInt('4295048017')
const HIGHEST_SQRT_PRICE = BigInt('79226673515401279992447579050')
/** `pool::swap_fee_rate` counts in millionths. */
const FEE_RATE_SCALE = 1e6

const VENUE_NAME = 'Momentum'
const FLASH_SWAP = moveTarget(MOMENTUM_PACKAGE, 'trade', 'flash_swap')
const RECEIPT_DEBTS = moveTarget(MOMENTUM_PACKAGE, 'trade', 'swap_receipt_debts')
const REPAY = moveTarget(MOMENTUM_PACKAGE, 'trade', 'repay_flash_swap')
const DESTROY_ZERO_BALANCE = moveTarget('0x2', 'balance', 'destroy_zero')
const ZERO_BALANCE = moveTarget('0x2', 'balance', 'zero')
const INTO_BALANCE = moveTarget('0x2', 'coin', 'into_balance')
const FROM_BALANCE = moveTarget('0x2', 'coin', 'from_balance')
const SPLIT_COIN = moveTarget('0x2', 'coin', 'split')

/**
 * `trade::flash_swap` takes no minimum, so the transaction states one: `coin::split` of the output
 * aborts when the output holds less. It is a framework call rather than a SplitCoins command so
 * that a miss reads as a failed swap, not as a wallet short of coins.
 */
export const MOMENTUM_POLICY: PtbPolicy = {
  venueName: VENUE_NAME,
  allowedCalls: new Set([
    FLASH_SWAP,
    RECEIPT_DEBTS,
    REPAY,
    DESTROY_ZERO_BALANCE,
    ZERO_BALANCE,
    INTO_BALANCE,
    FROM_BALANCE,
    SPLIT_COIN,
  ]),
}

/**
 * Exactly one exact-in swap on a pinned pool, repaid to the same pool, whose whole output goes
 * through one stated minimum. These balance and coin calls are only safe in this shape.
 */
function assertOneGuardedSwap(payload: SigningPayload): void {
  const data = dataOf(payload)
  const flashes = moveCallsNamed(data, FLASH_SWAP)
  const repays = moveCallsNamed(data, REPAY)
  const [flash] = flashes
  const [repay] = repays
  if (flash === undefined || repay === undefined || flashes.length !== 1 || repays.length !== 1) {
    return refuse('This transaction should make exactly one swap.')
  }

  const { call } = flash
  const poolId = sharedObjectId(data, call.arguments[0])
  const pool = MOMENTUM_POOLS.find((p) => normalizeSuiAddress(p.id) === poolId)
  if (
    pool === undefined ||
    !sameType(call.typeArguments[0], tokenType(pool.x)) ||
    !sameType(call.typeArguments[1], tokenType(pool.y)) ||
    sharedObjectId(data, repay.call.arguments[0]) !== poolId ||
    !sameType(repay.call.typeArguments[0], tokenType(pool.x)) ||
    !sameType(repay.call.typeArguments[1], tokenType(pool.y))
  ) {
    return refuse('This swap uses a Momentum pool I have not confirmed for these tokens.')
  }

  const version = normalizeSuiAddress(MOMENTUM_VERSION)
  const xToY = literalBool(data, call.arguments[1])
  if (
    call.arguments.length !== 7 ||
    repay.call.arguments.length !== 5 ||
    xToY === undefined ||
    literalBool(data, call.arguments[2]) !== true ||
    sharedObjectId(data, call.arguments[5]) !== normalizeSuiAddress(CLOCK) ||
    sharedObjectId(data, call.arguments[6]) !== version ||
    sharedObjectId(data, repay.call.arguments[4]) !== version
  ) {
    refuse('This swap does not match what Momentum takes.')
  }

  const outSide = xToY ? 1 : 0
  const outType = tokenType(xToY ? pool.y : pool.x)
  const outputs = moveCallsNamed(data, FROM_BALANCE)
  const [output] = outputs
  const taken = resultOf(output?.call.arguments[0])
  const splits = moveCallsNamed(data, SPLIT_COIN)
  const [split] = splits
  const splitFrom = resultOf(split?.call.arguments[0])
  const floor = literalU64(data, split?.call.arguments[1])
  if (
    output === undefined ||
    outputs.length !== 1 ||
    splits.length !== 1 ||
    taken?.[0] !== flash.at ||
    taken[1] !== outSide ||
    !sameType(output.call.typeArguments[0], outType) ||
    splitFrom?.[0] !== output.at ||
    floor === undefined ||
    floor === BigInt(0)
  ) {
    refuse('This swap has no minimum amount out on what it pays you.')
  }
}

/** The pool's own calculation of this swap, with no coin needed to run it. */
async function readFill(request: ChainActionRequest, account: string, io: SwapIo) {
  assertSuiAccount(account)
  const pairs = MOMENTUM_POOLS.map((p) => [p.x, p.y] as const)
  const { pairIndex, ...tokens } = pairTokens(VENUE_NAME, pairs, request)
  const pool = MOMENTUM_POOLS[pairIndex]
  if (pool === undefined) return refuse('Momentum has no pool for this pair.')
  const xToY = tokens.inIsFirst
  const typeArguments = [tokenType(pool.x), tokenType(pool.y)]
  const limit = xToY ? LOWEST_SQRT_PRICE : HIGHEST_SQRT_PRICE

  const tx = new Transaction()
  tx.setSender(account)
  const object = tx.sharedObjectRef({
    objectId: pool.id,
    initialSharedVersion: pool.initialSharedVersion,
    mutable: false,
  })
  const [state] = tx.moveCall({
    target: `${MOMENTUM_PACKAGE}::trade::compute_swap_result`,
    typeArguments,
    arguments: [
      object,
      tx.pure.bool(xToY),
      tx.pure.bool(true),
      tx.pure.u128(limit),
      tx.pure.u64(tokens.amountIn),
    ],
  })
  if (state === undefined) throw new Error('Reading the swap returned nothing.')
  for (const field of [
    'get_state_amount_calculated',
    'get_state_amount_specified',
    'get_state_sqrt_price',
  ]) {
    tx.moveCall({ target: `${MOMENTUM_PACKAGE}::trade::${field}`, arguments: [state] })
  }
  tx.moveCall({
    target: `${MOMENTUM_PACKAGE}::pool::sqrt_price`,
    typeArguments,
    arguments: [object],
  })
  tx.moveCall({
    target: `${MOMENTUM_PACKAGE}::pool::swap_fee_rate`,
    typeArguments,
    arguments: [object],
  })
  const views = await readOrRefuse(io, tx, VENUE_NAME)

  const out = u64At(views, 1, 0)
  const unspent = u64At(views, 2, 0)
  const ratio = Number(u128At(views, 3, 0)) / Number(u128At(views, 4, 0))
  const fill: Fill = { venueName: VENUE_NAME, tokens, unspent, out, impact: ratio * ratio - 1 }
  await judgeFill(io, fill)
  const feeRate = Number(u64At(views, 5, 0)) / FEE_RATE_SCALE
  return { fill, pool, xToY, typeArguments, limit, feeRate }
}

export function createMomentumVenue(io: SwapIo = LIVE_SWAP_IO): ChainVenue {
  async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
    const { fill } = await readFill(request, account, io)
    const { tokenOut } = fill.tokens
    return {
      receive: { amount: displayAmount(fill.out, tokenOut.decimals), symbol: tokenOut.symbol },
    }
  }

  async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
    const { fill, pool, xToY, typeArguments, limit, feeRate } = await readFill(request, account, io)
    const { tokens } = fill
    const { tokenIn, tokenOut } = tokens
    const inType = tokenType(tokenIn.symbol)
    const outType = tokenType(tokenOut.symbol)

    const tx = new Transaction()
    tx.setSender(account)
    const input = io.spend(tx, tokenIn, tokens.amountIn)
    const object = tx.sharedObjectRef({
      objectId: pool.id,
      initialSharedVersion: pool.initialSharedVersion,
      mutable: true,
    })
    const version = tx.sharedObjectRef({
      objectId: MOMENTUM_VERSION,
      initialSharedVersion: VERSION_SHARED_VERSION,
      mutable: false,
    })
    const [balanceX, balanceY, receipt] = tx.moveCall({
      target: FLASH_SWAP,
      typeArguments,
      arguments: [
        object,
        tx.pure.bool(xToY),
        tx.pure.bool(true),
        tx.pure.u64(tokens.amountIn),
        tx.pure.u128(limit),
        tx.sharedObjectRef({
          objectId: CLOCK,
          initialSharedVersion: CLOCK_SHARED_VERSION,
          mutable: false,
        }),
        version,
      ],
    })
    if (balanceX === undefined || balanceY === undefined || receipt === undefined) {
      throw new Error('The swap returned nothing.')
    }
    tx.moveCall({
      target: DESTROY_ZERO_BALANCE,
      typeArguments: [inType],
      arguments: [xToY ? balanceX : balanceY],
    })
    const [debtX, debtY] = tx.moveCall({ target: RECEIPT_DEBTS, arguments: [receipt] })
    const debt = xToY ? debtX : debtY
    if (debt === undefined) throw new Error('The swap reported no debt.')
    const [payment] = tx.splitCoins(input, [debt])
    if (payment === undefined) throw new Error('Splitting a coin returned nothing.')
    const [paid] = tx.moveCall({
      target: INTO_BALANCE,
      typeArguments: [inType],
      arguments: [payment],
    })
    const [nothing] = tx.moveCall({ target: ZERO_BALANCE, typeArguments: [outType] })
    if (paid === undefined || nothing === undefined) throw new Error('A balance returned nothing.')
    tx.moveCall({
      target: REPAY,
      typeArguments,
      arguments: [object, receipt, xToY ? paid : nothing, xToY ? nothing : paid, version],
    })
    const [output] = tx.moveCall({
      target: FROM_BALANCE,
      typeArguments: [outType],
      arguments: [xToY ? balanceY : balanceX],
    })
    if (output === undefined) throw new Error('The output returned nothing.')
    const [minimum] = tx.moveCall({
      target: SPLIT_COIN,
      typeArguments: [outType],
      arguments: [output, tx.pure.u64(minimumOut(fill.out))],
    })
    if (minimum === undefined) throw new Error('Splitting a coin returned nothing.')
    tx.mergeCoins(output, [minimum])
    tx.transferObjects([input, output], account)
    const transaction = await io.build(tx, tokenIn.symbol)

    const receive = displayAmount(fill.out, tokenOut.decimals)
    return {
      venueId: 'momentum',
      venueName: VENUE_NAME,
      kind: 'swap',
      summary: `Swap ${request.amount} ${tokenIn.symbol} for about ${receive} ${tokenOut.symbol} through Momentum.`,
      pay: { amount: request.amount, symbol: tokenIn.symbol },
      receive: { amount: receive, symbol: tokenOut.symbol, approximate: true },
      notes: [
        slippageNote(),
        `This pool's fee is ${Number((feeRate * 100).toFixed(4))}%, and the amount shown already includes it.`,
        ...unspentNote(fill),
        "Momentum's admins, through a multisig account, can upgrade these contracts and pause trading, and contracts can fail. DefiLlama lists no exploit of Momentum as of November 2026.",
        ...bridgeNote(tokens),
      ],
      signing: { family: 'sui', transaction },
    }
  }

  return {
    id: 'momentum',
    name: VENUE_NAME,
    kinds: ['swap'],
    quote,
    prepare,
    assertSafe: (payload: SigningPayload, account: string) => {
      assertPtbSafe(payload, account, MOMENTUM_POLICY)
      assertOneGuardedSwap(payload)
    },
  }
}

export const momentumVenue = createMomentumVenue()
