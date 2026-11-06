import {
  decodeFunctionData,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  getAddress,
  hashTypedData,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from 'viem'

import { ChainActionRefused, type SigningPayload } from '../types'
import { AVALANCHE_TOKENS } from './tokens'

/**
 * CoW Protocol on Avalanche, pinned from docs/research/2026-11-05-limit-orders/evm.md part A.
 * Client-safe: the wallet adapter runs `assertCowOrderShape` again before it asks for a signature.
 */

export const COW_CHAIN_ID = 43114
export const COW_SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'
export const COW_VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110'
export const WAVAX = '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7'
/** What CoW takes as the buy token to pay out the chain's own coin. Never a sell token. */
export const COW_BUY_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
/** No hooks, no partner fee, nothing else. The order signs its hash. */
export const COW_APP_DATA = '{}'
export const COW_APP_DATA_HASH = keccak256(toHex(COW_APP_DATA))
export const COW_ORDER_LIFETIME_S = 7 * 86_400
/** Leeway over the seven days for a clock that runs ahead, and no more. */
const MOST_LIFETIME_S = 8 * 86_400
const WRAP_DATA = '0xd0e30db0'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const MAX_UINT256 = BigInt(2) ** BigInt(256) - BigInt(1)

export const COW_DOMAIN = {
  name: 'Gnosis Protocol',
  version: 'v2',
  chainId: COW_CHAIN_ID,
  verifyingContract: COW_SETTLEMENT,
} as const

export const COW_ORDER_TYPES = {
  Order: [
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' },
    { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'string' },
    { name: 'partiallyFillable', type: 'bool' },
    { name: 'sellTokenBalance', type: 'string' },
    { name: 'buyTokenBalance', type: 'string' },
  ],
} as const

export const SETTLEMENT_ABI = parseAbi(['function invalidateOrder(bytes orderUid)'])

/** An order as signed, amounts in decimal base units so it survives JSON. */
export interface CowOrder {
  sellToken: string
  buyToken: string
  receiver: string
  sellAmount: string
  buyAmount: string
  validTo: number
  appData: string
  feeAmount: string
  kind: 'sell'
  partiallyFillable: boolean
  sellTokenBalance: 'erc20'
  buyTokenBalance: 'erc20'
}

export type CowTypedPayload = Extract<SigningPayload, { family: 'evm-typed' }>

const ORDER_KEYS = COW_ORDER_TYPES.Order.map((f) => f.name)

function token(symbol: string): string {
  const found = AVALANCHE_TOKENS.find((t) => t.symbol === symbol)
  if (found === undefined) throw new Error(`${symbol} is not in the Avalanche token table`)
  return found.id
}

const STABLES = [token('USDC'), token('USDT')].map((a) => a.toLowerCase())
const SELLS = [WAVAX.toLowerCase(), ...STABLES]
const BUYS = [COW_BUY_NATIVE.toLowerCase(), ...STABLES]

function refuse(sentence: string): never {
  throw new ChainActionRefused(`${sentence} Nothing was signed or sent.`)
}

function same(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
}

function isAddressText(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
}

function isUnits(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,77}$/.test(value) && BigInt(value) <= MAX_UINT256
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((k) => own.includes(k))
}

export function cowOrder(fields: {
  sellToken: string
  buyToken: string
  receiver: string
  sellAmount: string
  buyAmount: string
  validTo: number
}): CowOrder {
  return {
    ...fields,
    appData: COW_APP_DATA_HASH,
    feeAmount: '0',
    kind: 'sell',
    partiallyFillable: true,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
  }
}

export function cowTypedData(message: CowOrder): CowTypedPayload['typedData'] {
  return {
    domain: { ...COW_DOMAIN },
    types: { Order: COW_ORDER_TYPES.Order.map((f) => ({ ...f })) },
    primaryType: 'Order',
    message,
  }
}

/** What viem hashes and signs: the same order, with its amounts as numbers. */
export function viemTypedData(message: CowOrder) {
  return {
    domain: { ...COW_DOMAIN, verifyingContract: COW_SETTLEMENT as Address },
    types: COW_ORDER_TYPES,
    primaryType: 'Order' as const,
    message: {
      sellToken: message.sellToken as Address,
      buyToken: message.buyToken as Address,
      receiver: message.receiver as Address,
      sellAmount: BigInt(message.sellAmount),
      buyAmount: BigInt(message.buyAmount),
      validTo: message.validTo,
      appData: message.appData as Hex,
      feeAmount: BigInt(message.feeAmount),
      kind: message.kind,
      partiallyFillable: message.partiallyFillable,
      sellTokenBalance: message.sellTokenBalance,
      buyTokenBalance: message.buyTokenBalance,
    },
  }
}

/** The order's 56-byte id: its EIP-712 digest, its owner, and its validTo. Lower case. */
export function cowOrderUid(message: CowOrder, owner: string): string {
  const digest = hashTypedData(viemTypedData(message))
  return encodePacked(
    ['bytes32', 'address', 'uint32'],
    [digest, getAddress(owner.toLowerCase()), message.validTo]
  ).toLowerCase()
}

export function isCowOrderUid(value: string): boolean {
  return /^0x[0-9a-fA-F]{112}$/.test(value)
}

/** The owner an order id names. */
export function uidOwner(uid: string): string {
  return `0x${uid.slice(66, 106)}`.toLowerCase()
}

/**
 * What can be checked of a typed order without knowing what was asked: that it is a CoW order on
 * Avalanche, for this account, paying this account, plain, and short-lived. The wallet adapter runs
 * this too, so no typed message but this one is ever put in front of the wallet.
 */
export function assertCowOrderShape(
  payload: SigningPayload,
  account: string,
  now: number = Date.now()
): CowOrder {
  if (payload.family !== 'evm-typed') refuse('That is not a CoW order to sign.')
  if (!isAddressText(account)) refuse('That is not an Avalanche wallet address.')
  if (payload.chainId !== COW_CHAIN_ID) refuse('That order is not for Avalanche.')
  if (!same(payload.account, account)) refuse('That order is for another wallet.')
  const { typedData } = payload
  if (!hasExactKeys(typedData, ['domain', 'types', 'primaryType', 'message'])) {
    refuse('That order has an unexpected shape.')
  }
  const { domain, types, primaryType } = typedData
  if (
    !hasExactKeys(domain, ['name', 'version', 'chainId', 'verifyingContract']) ||
    domain['name'] !== COW_DOMAIN.name ||
    domain['version'] !== COW_DOMAIN.version ||
    domain['chainId'] !== COW_CHAIN_ID ||
    !same(domain['verifyingContract'], COW_SETTLEMENT)
  ) {
    refuse('That order is not for CoW’s settlement contract on Avalanche.')
  }
  if (primaryType !== 'Order' || JSON.stringify(types) !== JSON.stringify(COW_ORDER_TYPES)) {
    refuse('That is not a CoW order to sign.')
  }

  const message: unknown = typedData.message
  if (!hasExactKeys(message, ORDER_KEYS)) refuse('That order has an unexpected shape.')
  const { sellToken, buyToken, receiver, sellAmount, buyAmount, validTo } = message
  if (!isAddressText(sellToken) || !SELLS.includes(sellToken.toLowerCase())) {
    refuse('That order sells a token this app doesn’t trade on CoW.')
  }
  if (!isAddressText(buyToken) || !BUYS.includes(buyToken.toLowerCase())) {
    refuse('That order buys a token this app doesn’t trade on CoW.')
  }
  if (STABLES.includes(sellToken.toLowerCase()) === STABLES.includes(buyToken.toLowerCase())) {
    refuse('That order needs AVAX on one side and USDC or USDT on the other.')
  }
  if (!isAddressText(receiver) || same(receiver, ZERO_ADDRESS) || !same(receiver, account)) {
    refuse('That order pays someone other than your wallet.')
  }
  if (!isUnits(sellAmount) || !isUnits(buyAmount)) refuse('That order has a malformed amount.')
  const nowS = Math.floor(now / 1000)
  if (typeof validTo !== 'number' || !Number.isInteger(validTo) || validTo <= nowS) {
    refuse('That order has already expired.')
  }
  if (validTo > nowS + MOST_LIFETIME_S) refuse('That order lasts longer than this app allows.')
  if (!same(message['appData'], COW_APP_DATA_HASH)) {
    refuse('That order carries app data this app didn’t write, which could run hooks.')
  }
  if (message['feeAmount'] !== '0') refuse('That order signs a fee, and a limit order signs none.')
  if (message['kind'] !== 'sell' || message['partiallyFillable'] !== true) {
    refuse('That order is not a sell order that can fill in parts.')
  }
  if (message['sellTokenBalance'] !== 'erc20' || message['buyTokenBalance'] !== 'erc20') {
    refuse('That order draws on a balance other than your wallet’s own tokens.')
  }
  return message as unknown as CowOrder
}

function assertTransaction(
  payload: SigningPayload
): asserts payload is Extract<SigningPayload, { family: 'evm' }> {
  if (payload.family !== 'evm') refuse('That is not an Avalanche transaction.')
  if (payload.chainId !== COW_CHAIN_ID) refuse('That transaction is not for Avalanche.')
  if (!isAddressText(payload.to) || !/^\d+$/.test(payload.value)) {
    refuse('That transaction is malformed.')
  }
}

function assertWrap(payload: SigningPayload, context: Record<string, string>): void {
  assertTransaction(payload)
  const most = context['amount']
  if (!same(context['sellToken'], WAVAX) || !isUnits(most))
    refuse('That wrap was not prepared here.')
  if (!same(payload.to, WAVAX)) refuse('That wrap is not into WAVAX.')
  if (payload.data.toLowerCase() !== WRAP_DATA) refuse('That transaction does more than wrap AVAX.')
  const value = BigInt(payload.value)
  if (value === BigInt(0) || value > BigInt(most)) {
    refuse('That wraps more AVAX than this order sells.')
  }
}

function assertApproval(payload: SigningPayload, context: Record<string, string>): void {
  assertTransaction(payload)
  const sellToken = context['sellToken']
  const amount = context['amount']
  if (!isAddressText(sellToken) || !SELLS.includes(sellToken.toLowerCase()) || !isUnits(amount)) {
    refuse('That approval was not prepared here.')
  }
  if (!same(payload.to, sellToken)) refuse('That approval is on another token.')
  if (payload.value !== '0') refuse('An approval carries no AVAX.')
  let decoded: { functionName: string; args: readonly unknown[] }
  try {
    decoded = decodeFunctionData({ abi: erc20Abi, data: payload.data as Hex })
  } catch {
    return refuse('That transaction is not an approval.')
  }
  const [spender, approved] = decoded.args
  if (decoded.functionName !== 'approve' || !same(spender, COW_VAULT_RELAYER)) {
    refuse('That approval is not to CoW’s vault relayer.')
  }
  if (approved !== BigInt(amount)) refuse('That approval is not for exactly this order’s amount.')
  const exact = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [COW_VAULT_RELAYER, BigInt(amount)],
  })
  if (payload.data.toLowerCase() !== exact.toLowerCase()) {
    refuse('That transaction is not an approval.')
  }
}

function assertCancel(payload: SigningPayload, account: string, orderId: string): void {
  assertTransaction(payload)
  if (!isCowOrderUid(orderId) || !same(uidOwner(orderId), account)) {
    refuse('That order belongs to another wallet.')
  }
  if (!same(payload.to, COW_SETTLEMENT)) refuse('That cancel is not on CoW’s settlement contract.')
  if (payload.value !== '0') refuse('A cancel carries no AVAX.')
  const exact = encodeFunctionData({
    abi: SETTLEMENT_ABI,
    functionName: 'invalidateOrder',
    args: [orderId.toLowerCase() as Hex],
  })
  if (payload.data.toLowerCase() !== exact.toLowerCase()) refuse('That cancels a different order.')
}

function assertOrder(
  payload: SigningPayload,
  account: string,
  context: Record<string, string>,
  now: number
): void {
  const order = assertCowOrderShape(payload, account, now)
  if (
    !same(order.sellToken, context['sellToken'] ?? '') ||
    !same(order.buyToken, context['buyToken'] ?? '') ||
    order.sellAmount !== context['sellAmount'] ||
    order.buyAmount !== context['buyAmount'] ||
    String(order.validTo) !== context['validTo']
  ) {
    refuse('That order is not the one that was asked for.')
  }
}

/**
 * CoW's `assertSafe`: a payload held to the step `prepare` issued. At submit the order is rebuilt
 * from the context and its signature must recover to the account, so the context is only ever
 * compared with what the wallet signed.
 */
export function cowAssertSafe(
  payload: SigningPayload,
  account: string,
  context?: Record<string, string> | undefined,
  now: number = Date.now()
): void {
  if (!isAddressText(account)) refuse('That is not an Avalanche wallet address.')
  const orderId = context?.['orderId']
  if (orderId !== undefined) return assertCancel(payload, account, orderId)
  const step = context?.['step']
  if (step === 'wrap') return assertWrap(payload, context ?? {})
  if (step === 'approve') return assertApproval(payload, context ?? {})
  if (step === 'order') return assertOrder(payload, account, context ?? {}, now)
  refuse('That is not a step this app prepared.')
}
