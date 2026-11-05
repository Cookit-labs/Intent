import { Transaction } from '@mysten/sui/transactions'
import { fromBase64, normalizeStructTag, normalizeSuiAddress, toBase64 } from '@mysten/sui/utils'

import { ChainActionRefused, type SigningPayload } from '../types'
import { suiClient, withTimeout } from './client'
import type { PtbPolicy } from './safety'
import { moveTarget } from './safety'

/**
 * What the Sui lending venues share. `assertPtbSafe` reads targets, signer and
 * recipients. It can't see object inputs, so this adds what an allowed call may be
 * pointed at: the token, the market and the literals.
 */
export interface PinnedCall {
  typeArguments: readonly string[]
  argumentCount: number
  /** The object that must sit at an argument position. */
  objects?: Readonly<Record<number, string>> | undefined
  /** The literal bytes that must sit at an argument position, as base64. */
  pure?: Readonly<Record<number, string>> | undefined
}

export type PinnedCalls = ReadonlyMap<string, PinnedCall>

export function u64Bytes(value: number): string {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true)
  return toBase64(bytes)
}

export function pinnedPolicy(venueName: string, pins: PinnedCalls): PtbPolicy {
  return { venueName, allowedCalls: new Set(pins.keys()) }
}

function refuse(reason: string): never {
  throw new ChainActionRefused(`${reason} Nothing was signed or sent.`)
}

/** Run after `assertPtbSafe`, which has already refused anything not allowed. */
export function assertCallsPinned(
  payload: SigningPayload,
  pins: PinnedCalls,
  venueName: string
): void {
  if (payload.family !== 'sui') refuse('That is not a Sui transaction.')
  const data = Transaction.from(fromBase64(payload.transaction)).getData()

  for (const command of data.commands) {
    if (command.$kind !== 'MoveCall') continue
    const { package: pkg, module, function: fn, typeArguments, arguments: args } = command.MoveCall
    const pin = pins.get(moveTarget(pkg, module, fn))
    if (pin === undefined) continue

    const label = `${module}::${fn}`
    if (args.length !== pin.argumentCount) {
      refuse(`This transaction passes ${label} the wrong arguments for ${venueName}.`)
    }
    const sameTypes =
      typeArguments.length === pin.typeArguments.length &&
      typeArguments.every(
        (type, i) => normalizeStructTag(type) === normalizeStructTag(pin.typeArguments[i] ?? '')
      )
    if (!sameTypes) refuse(`This transaction uses a token ${venueName} isn't confirmed for.`)

    for (const [index, wanted] of Object.entries(pin.objects ?? {})) {
      const argument = args[Number(index)]
      const input = argument?.$kind === 'Input' ? data.inputs[argument.Input] : undefined
      const object = input?.$kind === 'Object' ? input.Object : undefined
      const id =
        object?.$kind === 'SharedObject'
          ? object.SharedObject.objectId
          : object?.$kind === 'ImmOrOwnedObject'
            ? object.ImmOrOwnedObject.objectId
            : undefined
      if (id === undefined || normalizeSuiAddress(id) !== normalizeSuiAddress(wanted)) {
        refuse(`This transaction points ${label} at an object ${venueName} doesn't use.`)
      }
    }
    for (const [index, wanted] of Object.entries(pin.pure ?? {})) {
      const argument = args[Number(index)]
      const input = argument?.$kind === 'Input' ? data.inputs[argument.Input] : undefined
      if (input?.$kind !== 'Pure' || input.Pure.bytes !== wanted) {
        refuse(`This transaction passes ${label} a value ${venueName} doesn't use.`)
      }
    }
  }
}

const DRY_RUN_TIMEOUT_MS = 15_000

/**
 * What a dry run, which moves nothing, says this account's balance of a coin would
 * change by. Nothing when the dry run failed or couldn't be read.
 */
export async function dryRunChange(
  transaction: string,
  coinType: string,
  account: string,
  what: string
): Promise<bigint | undefined> {
  const simulated = await withTimeout(
    suiClient().core.simulateTransaction({
      transaction: fromBase64(transaction),
      include: { effects: true, balanceChanges: true },
    }),
    DRY_RUN_TIMEOUT_MS,
    what
  )
  const result = simulated.Transaction
  if (result?.effects?.status.success !== true || result.balanceChanges === undefined) {
    return undefined
  }
  const me = normalizeSuiAddress(account)
  const coin = normalizeStructTag(coinType)
  const change = result.balanceChanges.find(
    (c) => normalizeStructTag(c.coinType) === coin && normalizeSuiAddress(c.address) === me
  )
  return change === undefined ? BigInt(0) : BigInt(change.amount)
}

/** A position's share price rounds, so a hundredth of a percent under what was asked still counts. */
export function gaveWhatWasAsked(received: bigint, asked: bigint): boolean {
  return received * BigInt(10_000) >= asked * BigInt(9_999)
}

export function coinTypeName(coinType: string): string {
  return normalizeStructTag(coinType).replace(/^0x/, '')
}
