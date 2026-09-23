import { stellarTestnet } from '@intent/config'
import {
  Address,
  FeeBumpTransaction,
  TransactionBuilder,
  scValToNative,
} from '@stellar/stellar-sdk'
import type { xdr } from '@stellar/stellar-sdk'

/**
 * Admits a Noether order envelope only when every field is the user's own.
 *
 * Nothing signed here was built here. The gateway prepares the transaction,
 * and between its answer and the wallet prompt the bytes cross a network and
 * a browser. So the envelope is read back — contract, function, every
 * argument — and compared with what the user typed. Anything else is refused
 * by name, the same discipline as `assertOfframpPayment`.
 *
 * Two shapes are admitted, both read from the venue's own source and from a
 * real envelope decoded on 2026-09-23:
 *
 * - market `open_position(trader, asset: Symbol, collateral: i128,
 *   leverage: u32, direction: u32, acceptable_price: i128)` — what the
 *   gateway's `/v1/orders/prepare` builds.
 * - router `open_with_price(trader, collateral, leverage, direction,
 *   acceptable_price, attestation)` — what the venue's web app submits, with
 *   the asset inside the attestation map.
 *
 * `Direction` is a u32: Long = 0, Short = 1. The trader is the transaction
 * source, so the authorisation is `source_account` and one wallet signature
 * covers it; an auth entry of any other kind is refused because it would ask
 * for a signature this flow never shows the user.
 */

export interface PerpOrderExpectation {
  account: string
  /** Resolved from the gateway's `/v1/health`, never pinned. */
  contracts: { market: string; router: string }
  asset: string
  /** 7-decimal base units of the market's USDC. */
  collateral: string
  leverage: number
  side: 'long' | 'short'
}

export interface PerpOrderRead {
  contract: 'market' | 'router'
  functionName: string
  /** The worst fill the gateway allowed, base units; '0' means unbounded. */
  acceptablePrice: string
}

function refuse(field: string, detail: string): never {
  throw new Error(`refusing to sign perp order: ${field} — ${detail}`)
}

function sideOf(direction: number): 'long' | 'short' | undefined {
  return direction === 0 ? 'long' : direction === 1 ? 'short' : undefined
}

function native(arg: xdr.ScVal | undefined, what: string): unknown {
  if (arg === undefined) refuse(what, 'absent')
  try {
    return scValToNative(arg)
  } catch {
    refuse(what, 'could not be read')
  }
}

function addressOf(arg: xdr.ScVal | undefined, what: string): string {
  if (arg === undefined) refuse(what, 'absent')
  try {
    return Address.fromScVal(arg).toString()
  } catch {
    refuse(what, 'is not an address')
  }
}

function bigintOf(arg: xdr.ScVal | undefined, what: string): bigint {
  const value = native(arg, what)
  if (typeof value !== 'bigint') refuse(what, 'is not an integer')
  return value
}

function numberOf(arg: xdr.ScVal | undefined, what: string): number {
  const value = native(arg, what)
  if (typeof value !== 'number') refuse(what, 'is not a number')
  return value
}

/**
 * The checks the two shapes share, once their arguments are lined up.
 */
function checkCommon(
  read: {
    trader: string
    asset: string
    collateral: bigint
    leverage: number
    direction: number
    acceptable: bigint
  },
  expect: PerpOrderExpectation
): void {
  if (read.trader !== expect.account) {
    refuse('trader', `${read.trader} is not the signing account`)
  }
  if (read.asset !== expect.asset) {
    refuse('asset', `${read.asset} is not the ${expect.asset} market asked for`)
  }
  if (read.collateral !== BigInt(expect.collateral)) {
    refuse('collateral', `${read.collateral} is not the ${expect.collateral} asked for`)
  }
  if (read.leverage !== expect.leverage) {
    refuse('leverage', `${read.leverage}x is not the ${expect.leverage}x asked for`)
  }
  const side = sideOf(read.direction)
  if (side !== expect.side) {
    refuse('side', `${side ?? `direction ${read.direction}`} is not the ${expect.side} asked for`)
  }
  if (read.acceptable < BigInt(0)) {
    refuse('acceptable price', `${read.acceptable} is negative; the contract rejects it`)
  }
}

export function assertPerpOrder(xdr: string, expect: PerpOrderExpectation): PerpOrderRead {
  const decoded = TransactionBuilder.fromXDR(xdr, stellarTestnet.networkPassphrase)
  if (decoded instanceof FeeBumpTransaction)
    refuse('shape', 'fee bump transactions are not built here')
  const tx = decoded

  if (tx.source !== expect.account) refuse('source', `${tx.source} is not the signing account`)

  if (tx.operations.length !== 1) {
    refuse('operations', `exactly one operation is expected, found ${tx.operations.length}`)
  }
  const op = tx.operations[0] as unknown as {
    type: string
    func?: {
      type?: string
      invokeContract?: {
        contractAddress?: xdr.ScAddress
        functionName?: unknown
        args?: xdr.ScVal[]
      }
    }
    auth?: { credentials?: unknown }[]
  }
  if (op.type !== 'invokeHostFunction' || op.func?.type !== 'hostFunctionTypeInvokeContract') {
    refuse('operation', `${op.type} is not a contract invocation`)
  }
  const invocation = op.func.invokeContract
  if (invocation?.contractAddress === undefined) refuse('contract', 'could not be read')

  let contractId: string
  try {
    contractId = Address.fromScAddress(invocation.contractAddress).toString()
  } catch {
    refuse('contract', 'could not be read')
  }

  // The name decodes to an XdrString; `String()` yields the symbol.
  const functionName = String(invocation.functionName ?? '')
  const args = invocation.args ?? []

  // A `source_account` credential is covered by the envelope signature. Any
  // other kind — an address credential in particular — would need its own
  // signed authorisation, which this flow never presents to the user.
  for (const entry of op.auth ?? []) {
    if (entry.credentials !== 'source_account') {
      refuse('authorization', 'an auth entry is not covered by the source account signature')
    }
  }

  let contract: PerpOrderRead['contract']
  let read: Parameters<typeof checkCommon>[0]

  if (contractId === expect.contracts.market) {
    contract = 'market'
    if (functionName !== 'open_position') {
      refuse(
        'function',
        `${functionName} is not open_position; only an isolated open may be signed here`
      )
    }
    if (args.length !== 6)
      refuse('arguments', `open_position takes six arguments, found ${args.length}`)
    const asset = native(args[1], 'asset')
    if (typeof asset !== 'string') refuse('asset', 'is not a symbol')
    read = {
      trader: addressOf(args[0], 'trader'),
      asset,
      collateral: bigintOf(args[2], 'collateral'),
      leverage: numberOf(args[3], 'leverage'),
      direction: numberOf(args[4], 'direction'),
      acceptable: bigintOf(args[5], 'acceptable price'),
    }
  } else if (contractId === expect.contracts.router) {
    contract = 'router'
    if (functionName !== 'open_with_price') {
      refuse('function', `${functionName} is not open_with_price; only an open may be signed here`)
    }
    if (args.length !== 6)
      refuse('arguments', `open_with_price takes six arguments, found ${args.length}`)
    const attestation = native(args[5], 'attestation') as { asset?: unknown } | undefined
    const asset = attestation?.asset
    if (typeof asset !== 'string') refuse('asset', 'the attestation names no asset')
    read = {
      trader: addressOf(args[0], 'trader'),
      asset,
      collateral: bigintOf(args[1], 'collateral'),
      leverage: numberOf(args[2], 'leverage'),
      direction: numberOf(args[3], 'direction'),
      acceptable: bigintOf(args[4], 'acceptable price'),
    }
  } else {
    refuse('contract', `${contractId} is not the Noether market or router the gateway lists`)
  }

  checkCommon(read, expect)

  return { contract, functionName, acceptablePrice: read.acceptable.toString() }
}
