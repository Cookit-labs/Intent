import {
  decodeFunctionData,
  encodeFunctionData,
  isAddress,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from 'viem'

import { formatUnits } from '../near/tokens'
import {
  ChainActionRefused,
  toBaseUnits,
  tokenBySymbol,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
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
import { evmClient, evmReader, type EvmClient } from './client'
import { createEvmDeposit } from './deposit'
import { sameAddress, sameCalldata } from './submit'
import { EVM_CHAINS, EVM_NATIVE_ID, type EvmChain } from './tokens'

/**
 * One exact-input swap through a concentrated-liquidity pool, for routers built on Uniswap v3's.
 * Each router's calldata goes out as a multicall holding that swap, then a refund of any native
 * coin the pool didn't take. A person's whole request is single-hop, so the pool is decided by the
 * two tokens and a tier, and the router derives its address itself rather than taking one.
 */

// Router's `WETH9()` on chain, and Uniswap's sdk-core `src/entities/weth9.ts`.
export const WAVAX: ChainToken = {
  symbol: 'WAVAX',
  id: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
  decimals: 18,
  name: 'Wrapped AVAX',
}

// Router's `WETH9()` on chain, and https://docs.monad.xyz/developer-essentials/network-information.
export const WMON: ChainToken = {
  symbol: 'WMON',
  id: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
  decimals: 18,
  name: 'Wrapped MON',
}

export const REFUND_ABI = parseAbi(['function refundETH() payable'])

const REFUND_CALL = encodeFunctionData({ abi: REFUND_ABI, functionName: 'refundETH' })

/** The price can move this far between the quote and the swap before it reverts instead. */
const SLIPPAGE_BPS = BigInt(50)
/** The worst rate a size may get against a small trade on the same pool. Jupiter's limit here too. */
const MAX_IMPACT_BPS = BigInt(300)
const WHOLE_BPS = BigInt(10_000)
/** How much smaller the trade is that the rate is compared with. */
const PROBE_DIVISOR = BigInt(100)
const DEADLINE_SECONDS = 20 * 60
/**
 * The furthest ahead a deadline may be when it's checked. This is the only side of it that can be
 * checked: a landed swap is read back later, when its deadline has rightly passed. The extra is for
 * two servers' clocks.
 */
const LONGEST_DEADLINE_SECONDS = DEADLINE_SECONDS + 5 * 60

export interface SingleSwap {
  tokenIn: string
  tokenOut: string
  /** The fee or tick spacing that picks the pool, as this router names it. */
  tier: number
  recipient: string
  amountIn: bigint
  amountOutMinimum: bigint
  sqrtPriceLimitX96: bigint
  deadline: bigint
}

/** What one router does differently from another. */
export interface V3Router {
  id: string
  name: string
  chain: EvmChain
  router: string
  quoter: string
  wrapped: ChainToken
  /** All this venue trades: the native coin, the wrapped coin and stablecoins with verified pools. */
  tokens: readonly ChainToken[]
  /** Only tiers its factory has switched on. */
  tiers: readonly number[]
  /** The router's `exactInputSingle`, `multicall` and `refundETH`, and no other way in. */
  abi: Abi
  quoterAbi: Abi
  quoteParams: (tokenIn: string, tokenOut: string, amountIn: bigint, tier: number) => object
  swapParams: (swap: SingleSwap) => object
  readSwap: (params: unknown) => SingleSwap
  multicallArgs: (calls: readonly Hex[], deadline: bigint) => readonly unknown[]
  /** A deadline here, on a router whose multicall holds it, stands in for the swap's. */
  readMulticall: (args: readonly unknown[]) => { calls: readonly Hex[]; deadline?: bigint }
  /** Risks the card always states. */
  notes: readonly string[]
}

export interface V3SwapDeps {
  reader?: () => EvmReaderClient
  client?: () => EvmClient
}

function refuse(reason: string): never {
  throw new ChainActionRefused(`${reason} Nothing was signed or sent.`)
}

function readSwapCall(router: V3Router, data: Hex): SingleSwap {
  let decoded: { functionName: string; args?: readonly unknown[] | undefined }
  try {
    decoded = decodeFunctionData({ abi: router.abi, data })
  } catch {
    return refuse(`This transaction does something I haven't confirmed for ${router.name}.`)
  }
  if (decoded.functionName !== 'exactInputSingle') {
    return refuse(`This transaction does something I haven't confirmed for ${router.name}.`)
  }
  const args = decoded.args ?? []
  const again = encodeFunctionData({ abi: router.abi, functionName: 'exactInputSingle', args })
  if (!sameCalldata(again, data)) refuse('This transaction carries extra data.')
  return router.readSwap(args[0])
}

function checkCall(router: V3Router, call: DecodedCall, context: CheckContext): void {
  const { account, value, approval } = context
  const { calls, deadline: outerDeadline } = router.readMulticall(call.args)
  const paysNative = value > BigInt(0)
  if (calls.length !== (paysNative ? 2 : 1)) {
    refuse(`This transaction holds steps I haven't confirmed for ${router.name}.`)
  }
  const [swapCall, refundCall] = calls
  if (swapCall === undefined) return refuse('This transaction holds no swap.')
  if (paysNative && (refundCall === undefined || !sameCalldata(refundCall, REFUND_CALL))) {
    refuse('This swap pays the native coin without returning what the pool leaves.')
  }
  const swap = readSwapCall(router, swapCall)
  const deadline = outerDeadline ?? swap.deadline

  if (!sameAddress(swap.recipient, account)) refuse('This swap pays someone else.')
  const tradable = router.tokens.filter((token) => token.id !== EVM_NATIVE_ID)
  if (
    !tradable.some((token) => sameAddress(token.id, swap.tokenIn)) ||
    !tradable.some((token) => sameAddress(token.id, swap.tokenOut))
  ) {
    refuse(`This swap uses a token I haven't confirmed for ${router.name}.`)
  }
  if (sameAddress(swap.tokenIn, swap.tokenOut))
    refuse('This swap has the same token on both sides.')
  if (!router.tiers.includes(swap.tier)) {
    refuse(`This swap uses a pool I haven't confirmed for ${router.name}.`)
  }
  // Uniswap's router reads a zero amount as spending what it holds itself.
  if (swap.amountIn <= BigInt(0)) refuse('This swap has no amount.')
  if (swap.amountOutMinimum <= BigInt(0)) refuse('This swap has no minimum, so its price is open.')
  if (swap.sqrtPriceLimitX96 !== BigInt(0)) refuse('This swap could stop short of its amount.')
  const now = BigInt(Math.floor(Date.now() / 1000))
  if (deadline > now + BigInt(LONGEST_DEADLINE_SECONDS)) {
    refuse('This swap could sit unsent for too long.')
  }

  if (paysNative) {
    if (!sameAddress(swap.tokenIn, router.wrapped.id)) {
      refuse(`This swap sends ${EVM_CHAINS[router.chain].nativeSymbol} for another token.`)
    }
    if (swap.amountIn !== value) refuse('The value sent is not the amount of this swap.')
    if (approval !== undefined)
      refuse('This swap pays in the native coin, so it needs no approval.')
    return
  }
  if (approval !== undefined) {
    if (!sameAddress(approval.token, swap.tokenIn))
      refuse('This approves a token the swap doesn’t spend.')
    if (approval.units !== swap.amountIn) refuse('This approval is not the amount of this swap.')
  }
}

export function v3SwapPolicy(router: V3Router): EvmCallPolicy {
  return {
    venueName: router.name,
    chain: router.chain,
    contracts: {
      [router.router]: {
        abi: router.abi,
        functions: ['multicall'],
        check: (call, context) => checkCall(router, call, context),
      },
    },
    spenders: [router.router],
    approvable: router.tokens
      .filter((token) => token.id !== EVM_NATIVE_ID)
      .map((token) => token.id),
    mayPayNative: true,
  }
}

interface Trade {
  /** What the person spends, which is the native coin if they said so. */
  tokenIn: ChainToken
  /** What the pool takes in: the wrapped form where they spend the native coin. */
  sold: ChainToken
  tokenOut: ChainToken
  units: bigint
}

function readTrade(router: V3Router, request: ChainActionRequest): Trade {
  const { name, chain, tokens, wrapped } = router
  const chainName = EVM_CHAINS[chain].name
  if (request.kind !== 'swap') refuse(`${name} only swaps here.`)
  const tokenIn = tokenBySymbol(tokens, request.tokenIn)
  const tokenOut = tokenBySymbol(tokens, request.tokenOut ?? '')
  if (tokenIn === undefined || tokenOut === undefined) {
    return refuse(
      `${name} doesn't trade ${tokenIn === undefined ? request.tokenIn : (request.tokenOut ?? 'that')} on ${chainName} in this app.`
    )
  }
  if (tokenOut.id === EVM_NATIVE_ID) {
    refuse(
      `${name} pays out ${wrapped.symbol} here, not ${tokenOut.symbol}. Ask for ${wrapped.symbol} instead.`
    )
  }
  const sold = tokenIn.id === EVM_NATIVE_ID ? wrapped : tokenIn
  if (sameAddress(sold.id, tokenOut.id)) refuse('Those are the same token.')
  return { tokenIn, sold, tokenOut, units: BigInt(toBaseUnits(request.amount, tokenIn.decimals)) }
}

async function readOut(
  router: V3Router,
  reader: EvmReaderClient,
  trade: Trade,
  amountIn: bigint,
  tier: number
): Promise<bigint> {
  const { result } = await reader.simulateContract({
    address: router.quoter as Address,
    abi: router.quoterAbi,
    functionName: 'quoteExactInputSingle',
    args: [router.quoteParams(trade.sold.id, trade.tokenOut.id, amountIn, tier)],
  })
  const [amountOut] = result as readonly [bigint, ...unknown[]]
  return amountOut
}

interface BestQuote {
  tier: number
  amountOut: bigint
}

/**
 * The tier that pays most, from the router's own quoter. Most pools on these chains hold almost
 * nothing, so paying most doesn't mean enough: the rate this size gets is held against a far smaller
 * trade on that pool, and a pool that can't take the size is refused rather than quoted.
 */
async function bestQuote(
  router: V3Router,
  reader: EvmReaderClient,
  trade: Trade
): Promise<BestQuote> {
  const reads = await Promise.allSettled(
    router.tiers.map((tier) => readOut(router, reader, trade, trade.units, tier))
  )
  let best: BestQuote | undefined
  reads.forEach((read, index) => {
    const tier = router.tiers[index]
    if (read.status !== 'fulfilled' || tier === undefined) return
    if (read.value > (best?.amountOut ?? BigInt(0))) best = { tier, amountOut: read.value }
  })
  if (best === undefined) {
    return refuse(`I couldn't read a price for this pair on ${router.name} right now.`)
  }
  const probeIn = trade.units / PROBE_DIVISOR
  if (probeIn === BigInt(0)) return refuse('This amount is too small to price.')
  let probeOut: bigint
  try {
    probeOut = await readOut(router, reader, trade, probeIn, best.tier)
  } catch {
    return refuse(`I couldn't read a price for this pair on ${router.name} right now.`)
  }
  if (probeOut === BigInt(0)) return refuse('This amount is too small to price.')
  const worstAllowed = probeOut * trade.units * (WHOLE_BPS - MAX_IMPACT_BPS)
  if (best.amountOut * probeIn * WHOLE_BPS < worstAllowed) {
    refuse(`There isn't enough liquidity on ${router.name} for this size. Try a smaller amount.`)
  }
  return best
}

function shown(units: bigint, token: ChainToken): string {
  return formatUnits(units.toString(), token.decimals)
}

/** A `ChainVenue` for this router, whose reads only happen when a request comes. */
export function createV3SwapVenue(router: V3Router, deps: V3SwapDeps = {}): ChainVenue {
  const { id, name, chain, wrapped } = router
  const readerOf = deps.reader ?? (() => evmReader(chain))
  const clientOf = deps.client ?? (() => evmClient(chain))
  const policy = v3SwapPolicy(router)
  const { nativeSymbol } = EVM_CHAINS[chain]

  async function quote(request: ChainActionRequest): Promise<VenueQuote> {
    const trade = readTrade(router, request)
    const { amountOut } = await bestQuote(router, readerOf(), trade)
    return { receive: { amount: shown(amountOut, trade.tokenOut), symbol: trade.tokenOut.symbol } }
  }

  async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
    if (!isAddress(account)) refuse(`That is not an account on ${EVM_CHAINS[chain].name}.`)
    const trade = readTrade(router, request)
    const { tokenIn, sold, tokenOut, units } = trade
    const reader = readerOf()
    const { tier, amountOut } = await bestQuote(router, reader, trade)
    const amountOutMinimum = (amountOut * (WHOLE_BPS - SLIPPAGE_BPS)) / WHOLE_BPS
    if (amountOutMinimum === BigInt(0)) refuse('This amount is too small to price.')
    const fundsNotes = await createEvmDeposit(chain, clientOf).assertFunds(
      account,
      tokenIn,
      request.amount
    )

    const paysNative = tokenIn.id === EVM_NATIVE_ID
    const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS)
    const swapCall = encodeFunctionData({
      abi: router.abi,
      functionName: 'exactInputSingle',
      args: [
        router.swapParams({
          tokenIn: sold.id,
          tokenOut: tokenOut.id,
          tier,
          recipient: account,
          amountIn: units,
          amountOutMinimum,
          sqrtPriceLimitX96: BigInt(0),
          deadline,
        }),
      ],
    })
    const calls = paysNative ? [swapCall, REFUND_CALL] : [swapCall]
    const { signing, needsApproval } = await buildEvmCall(
      {
        chain,
        account,
        to: router.router,
        data: encodeFunctionData({
          abi: router.abi,
          functionName: 'multicall',
          args: router.multicallArgs(calls, deadline),
        }),
        ...(paysNative
          ? { value: units }
          : { pull: { token: sold.id, spender: router.router, units } }),
      },
      reader
    )
    const out = shown(amountOut, tokenOut)
    return {
      venueId: id,
      venueName: name,
      kind: 'swap',
      summary: `Swap ${request.amount} ${tokenIn.symbol} for about ${out} ${tokenOut.symbol} on ${name}.`,
      pay: { amount: request.amount, symbol: tokenIn.symbol },
      receive: { amount: out, symbol: tokenOut.symbol, approximate: true },
      notes: [
        `You get at least ${shown(amountOutMinimum, tokenOut)} ${tokenOut.symbol}, or the swap fails and only the network fee is spent. It stops being valid ${DEADLINE_SECONDS / 60} minutes after this was built.`,
        ...(needsApproval ? [approvalNote(name, request.amount, tokenIn.symbol)] : []),
        ...(paysNative
          ? [
              `The router wraps your ${nativeSymbol} for the pool, and sends back anything the pool doesn't take in the same transaction.`,
            ]
          : []),
        ...(sameAddress(tokenOut.id, wrapped.id)
          ? [
              `${wrapped.symbol} is the wrapped form of ${nativeSymbol}. It stays ${wrapped.symbol} in your wallet, and network fees still need ${nativeSymbol}.`,
            ]
          : []),
        ...fundsNotes,
        ...router.notes,
      ],
      signing,
    }
  }

  return {
    id,
    name,
    kinds: ['swap'],
    quote,
    prepare,
    ...evmCallVenueParts(policy, deps.client?.()),
  }
}
