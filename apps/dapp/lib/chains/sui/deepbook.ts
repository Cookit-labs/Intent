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
  u64At,
  unspentNote,
  type Fill,
  type SwapIo,
} from './direct-swap'
import { assertPtbSafe, moveTarget, type ParsedCall, type PtbPolicy } from './safety'
import { displayAmount } from './tokens'

/**
 * DeepBook core, version 9. `DEEPBOOK_PACKAGE_ID` in @mysten/deepbook-v3 2.10.1
 * (utils/constants.ts), and the Move Registry's @deepbook/core resolves to it. On chain, the
 * UpgradeCap 0xdadf253c...4483 names this package at version 9, and the book takes calls from it.
 */
export const DEEPBOOK_PACKAGE = '0xbca0cefe720330e7bb4f2283438b68de6a0e656688db4ac90d61e71fe6151fe8'

/** `DEEP.type` in the same file, and what `swap_exact_base_for_quote`'s signature asks for on chain. */
export const DEEP_TYPE =
  '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP'

export interface DeepbookPool {
  id: string
  initialSharedVersion: number
  base: string
  quote: string
}

/**
 * `mainnetPools` in the same file. On chain each object is a `pool::Pool<Base, Quote>` of these
 * coins, and `pool::get_pool_id_by_asset` on the registry 0xaf16199a...549d returns this id.
 */
export const DEEPBOOK_POOLS: readonly DeepbookPool[] = [
  {
    id: '0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407',
    initialSharedVersion: 389750322,
    base: 'SUI',
    quote: 'USDC',
  },
  {
    id: '0xfc28a2fb22579c16d672a1152039cbf671e5f4b9f103feddff4ea06ef3c2bc25',
    initialSharedVersion: 646905478,
    base: 'USDT',
    quote: 'USDC',
  },
  {
    id: '0x826eeacb2799726334aa580396338891205a41cf9344655e526aae6ddd5dc03f',
    initialSharedVersion: 804805725,
    base: 'SUI',
    quote: 'USDsui',
  },
  {
    id: '0xa374264d43e6baa5aa8b35ff18ff24fdba7443b4bcb884cb4c2f568d32cdac36',
    initialSharedVersion: 804805725,
    base: 'USDsui',
    quote: 'USDC',
  },
]

const VENUE_NAME = 'DeepBook'
const SELL_BASE = moveTarget(DEEPBOOK_PACKAGE, 'pool', 'swap_exact_base_for_quote')
const BUY_BASE = moveTarget(DEEPBOOK_PACKAGE, 'pool', 'swap_exact_quote_for_base')
const ZERO_COIN = moveTarget('0x2', 'coin', 'zero')
/** DeepBook scales its fee rates and prices by this. */
const FLOAT_SCALING = 1e9
/** `FEE_PENALTY_MULTIPLIER` in DeepBook's constants.move: paying in the input coin costs 25% more. */
const INPUT_FEE_MULTIPLIER = 1.25

function requirePair(swap: ParsedCall['typeArguments'], id: string | undefined): void {
  const pool = DEEPBOOK_POOLS.find((p) => normalizeSuiAddress(p.id) === id)
  if (
    pool === undefined ||
    !sameType(swap[0], tokenType(pool.base)) ||
    !sameType(swap[1], tokenType(pool.quote))
  ) {
    refuse('This swap uses a DeepBook pool I have not confirmed for these tokens.')
  }
}

export const DEEPBOOK_POLICY: PtbPolicy = {
  venueName: VENUE_NAME,
  allowedCalls: new Set([SELL_BASE, BUY_BASE, ZERO_COIN]),
  checkCall: (call) => {
    if (call.target === ZERO_COIN && !sameType(call.typeArguments[0], DEEP_TYPE)) {
      refuse('This swap makes an empty coin of something other than DEEP.')
    }
  },
}

/**
 * Exactly one swap, on a pinned pool of the coins it names, with a stated minimum and an empty DEEP
 * coin, so the fee comes out of the input and nothing else in the wallet is touched.
 */
function assertOneMarketSwap(payload: SigningPayload): void {
  const data = dataOf(payload)
  const swaps = [...moveCallsNamed(data, SELL_BASE), ...moveCallsNamed(data, BUY_BASE)]
  const [swap] = swaps
  if (swap === undefined || swaps.length !== 1) {
    return refuse('This transaction should make exactly one swap.')
  }
  const { call } = swap
  requirePair(call.typeArguments, sharedObjectId(data, call.arguments[0]))

  const [, , deep, minimum, clock, ...extra] = call.arguments
  if (extra.length > 0 || sharedObjectId(data, clock) !== normalizeSuiAddress(CLOCK)) {
    refuse('This swap does not match what DeepBook takes.')
  }
  const fromCommand = resultOf(deep)?.[0]
  const zero = moveCallsNamed(data, ZERO_COIN).find((z) => z.at === fromCommand)
  if (zero === undefined) refuse('This swap would spend DEEP from your wallet.')

  const floor = literalU64(data, minimum)
  if (floor === undefined || floor === BigInt(0)) {
    refuse('This swap has no minimum amount out.')
  }
}

/** The book's own dry run, with the fee paid from the input, as the swap below pays it. */
async function readFill(request: ChainActionRequest, account: string, io: SwapIo) {
  assertSuiAccount(account)
  const pairs = DEEPBOOK_POOLS.map((p) => [p.base, p.quote] as const)
  const { pairIndex, ...tokens } = pairTokens(VENUE_NAME, pairs, request)
  const pool = DEEPBOOK_POOLS[pairIndex]
  if (pool === undefined) return refuse('DeepBook has no pool for this pair.')
  const sellsBase = tokens.inIsFirst
  const typeArguments = [tokenType(pool.base), tokenType(pool.quote)]

  const tx = new Transaction()
  tx.setSender(account)
  const object = tx.sharedObjectRef({
    objectId: pool.id,
    initialSharedVersion: pool.initialSharedVersion,
    mutable: false,
  })
  const clock = tx.sharedObjectRef({
    objectId: CLOCK,
    initialSharedVersion: CLOCK_SHARED_VERSION,
    mutable: false,
  })
  tx.moveCall({
    target: `${DEEPBOOK_PACKAGE}::pool::${sellsBase ? 'get_quote_quantity_out_input_fee' : 'get_base_quantity_out_input_fee'}`,
    typeArguments,
    arguments: [object, tx.pure.u64(tokens.amountIn), clock],
  })
  tx.moveCall({
    target: `${DEEPBOOK_PACKAGE}::pool::mid_price`,
    typeArguments,
    arguments: [object, clock],
  })
  tx.moveCall({
    target: `${DEEPBOOK_PACKAGE}::pool::pool_trade_params`,
    typeArguments,
    arguments: [object],
  })
  const views = await readOrRefuse(io, tx, VENUE_NAME)

  // Both directions return (base, quote, DEEP required): one is what's left, the other what's bought.
  const unspent = u64At(views, 0, sellsBase ? 0 : 1)
  const out = u64At(views, 0, sellsBase ? 1 : 0)
  const spent = BigInt(tokens.amountIn) - BigInt(unspent)
  const mid = Number(u64At(views, 1, 0)) / FLOAT_SCALING
  const paid = sellsBase ? Number(out) / Number(spent) : Number(spent) / Number(out)
  const fill: Fill = {
    venueName: VENUE_NAME,
    tokens,
    unspent,
    out,
    impact: paid / mid - 1,
  }
  await judgeFill(io, fill)
  const feeRate = (Number(u64At(views, 2, 0)) / FLOAT_SCALING) * INPUT_FEE_MULTIPLIER
  return { fill, pool, sellsBase, typeArguments, feeRate }
}

export function createDeepbookVenue(io: SwapIo = LIVE_SWAP_IO): ChainVenue {
  async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
    const { fill } = await readFill(request, account, io)
    const { tokenOut } = fill.tokens
    return {
      receive: { amount: displayAmount(fill.out, tokenOut.decimals), symbol: tokenOut.symbol },
    }
  }

  async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
    const { fill, pool, sellsBase, typeArguments, feeRate } = await readFill(request, account, io)
    const { tokens } = fill
    const { tokenIn, tokenOut } = tokens

    const tx = new Transaction()
    tx.setSender(account)
    const input = io.spend(tx, tokenIn, tokens.amountIn)
    const [emptyDeep] = tx.moveCall({ target: ZERO_COIN, typeArguments: [DEEP_TYPE] })
    if (emptyDeep === undefined) throw new Error('An empty coin returned nothing.')
    const [base, quoteCoin, deep] = tx.moveCall({
      target: sellsBase ? SELL_BASE : BUY_BASE,
      typeArguments,
      arguments: [
        tx.sharedObjectRef({
          objectId: pool.id,
          initialSharedVersion: pool.initialSharedVersion,
          mutable: true,
        }),
        input,
        emptyDeep,
        tx.pure.u64(minimumOut(fill.out)),
        tx.sharedObjectRef({
          objectId: CLOCK,
          initialSharedVersion: CLOCK_SHARED_VERSION,
          mutable: false,
        }),
      ],
    })
    if (base === undefined || quoteCoin === undefined || deep === undefined) {
      throw new Error('The swap returned nothing.')
    }
    tx.moveCall({
      target: '0x2::coin::destroy_zero',
      typeArguments: [DEEP_TYPE],
      arguments: [deep],
    })
    tx.transferObjects([base, quoteCoin], account)
    const transaction = await io.build(tx, tokenIn.symbol)

    const receive = displayAmount(fill.out, tokenOut.decimals)
    return {
      venueId: 'deepbook',
      venueName: VENUE_NAME,
      kind: 'swap',
      summary: `Swap ${request.amount} ${tokenIn.symbol} for about ${receive} ${tokenOut.symbol} on DeepBook's order book.`,
      pay: { amount: request.amount, symbol: tokenIn.symbol },
      receive: { amount: receive, symbol: tokenOut.symbol, approximate: true },
      notes: [
        slippageNote(),
        `This trades at the market on an order book. The fee is about ${Number((feeRate * 100).toFixed(4))}%, taken from what you pay, which costs 25% more than paying it in DEEP.`,
        ...unspentNote(fill),
        "A multisig account can upgrade DeepBook's contracts, and contracts can fail. DefiLlama lists no exploit of DeepBook as of November 2026.",
        ...bridgeNote(tokens),
      ],
      signing: { family: 'sui', transaction },
    }
  }

  return {
    id: 'deepbook',
    name: VENUE_NAME,
    kinds: ['swap'],
    quote,
    prepare,
    assertSafe: (payload: SigningPayload, account: string) => {
      assertPtbSafe(payload, account, DEEPBOOK_POLICY)
      assertOneMarketSwap(payload)
    },
  }
}

export const deepbookVenue = createDeepbookVenue()
