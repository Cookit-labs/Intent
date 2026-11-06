import { bcs } from '@mysten/sui/bcs'
import { Transaction } from '@mysten/sui/transactions'
import { fromBase64, isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils'

import { ChainActionRefused, type SigningPayload } from '../types'

type TxData = ReturnType<Transaction['getData']>
type TxCommand = TxData['commands'][number]
type MoveCall = Extract<TxCommand, { $kind: 'MoveCall' }>['MoveCall']
type TxArgument = MoveCall['arguments'][number]

export interface ParsedCall {
  target: string
  typeArguments: readonly string[]
  arguments: readonly TxArgument[]
}

/** The bytes of a literal argument, or nothing when the value comes from elsewhere in the transaction. */
export type ReadPure = (argument: TxArgument | undefined) => Uint8Array | undefined

/** The id of an object argument, or nothing when the value comes from elsewhere in the transaction. */
export type ReadObject = (argument: TxArgument | undefined) => string | undefined

export interface PtbPolicy {
  venueName: string
  /** Normalized `package::module::function`. A package alone is too coarse: see below. */
  allowedCalls: ReadonlySet<string>
  /** Checks the arguments of an allowed call, where they can name a recipient or a limit. */
  checkCall?: (call: ParsedCall, read: ReadPure, account: string, readObject: ReadObject) => void
}

export function moveTarget(pkg: string, module: string, fn: string): string {
  return `${normalizeSuiAddress(pkg)}::${module}::${fn}`
}

const SEND_FUNDS = moveTarget('0x2', 'coin', 'send_funds')

/**
 * What `coinWithBalance` emits for an account with address-balance funds. Named one
 * by one, because allowing the framework package would allow
 * `0x2::transfer::public_transfer`, which sends anything anywhere without ever
 * appearing as a TransferObjects command.
 */
const FRAMEWORK_CALLS: ReadonlySet<string> = new Set([
  moveTarget('0x2', 'coin', 'redeem_funds'),
  moveTarget('0x2', 'coin', 'destroy_zero'),
  SEND_FUNDS,
])

const NOTHING_SENT = 'Nothing was signed or sent.'

function refuse(reason: string): never {
  throw new ChainActionRefused(`${reason} ${NOTHING_SENT}`)
}

export function parsePtb(transaction: string): TxData {
  // Only BCS bytes. The JSON form can hold unresolved values that are not what gets signed.
  if (transaction === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(transaction)) {
    refuse('I could not read this as a Sui transaction.')
  }
  try {
    return Transaction.from(fromBase64(transaction)).getData()
  } catch {
    return refuse('I could not read this as a Sui transaction.')
  }
}

export function readerFor(data: TxData): ReadPure {
  return (argument) => {
    if (argument === undefined || argument.$kind !== 'Input') return undefined
    const input = data.inputs[argument.Input]
    if (input?.$kind !== 'Pure') return undefined
    return fromBase64(input.Pure.bytes)
  }
}

export function objectReaderFor(data: TxData): ReadObject {
  return (argument) => {
    if (argument === undefined || argument.$kind !== 'Input') return undefined
    const input = data.inputs[argument.Input]
    if (input?.$kind !== 'Object') return undefined
    const { Object: held } = input
    const id =
      held.$kind === 'SharedObject'
        ? held.SharedObject.objectId
        : held.$kind === 'ImmOrOwnedObject'
          ? held.ImmOrOwnedObject.objectId
          : held.Receiving.objectId
    return normalizeSuiAddress(id)
  }
}

function assertPaysAccount(read: ReadPure, destination: TxArgument | undefined, me: string): void {
  const bytes = read(destination)
  let recipient: string | undefined
  try {
    recipient = bytes === undefined ? undefined : normalizeSuiAddress(bcs.Address.parse(bytes))
  } catch {
    recipient = undefined
  }
  if (recipient !== me) refuse('This transaction would send funds to another address.')
}

/**
 * Refuses anything but what the venue is confirmed to do, on what the wallet would
 * actually sign. It runs before the user sees a transaction and again on the signed
 * bytes, because the venue's API and the browser are outside this server's control.
 *
 * A protocol upgrade publishes a new package id. An id not listed here is refused,
 * so an upgrade blocks the venue until someone confirms the new id and adds it. It
 * cannot widen what is trusted on its own.
 */
export function assertPtbSafe(payload: SigningPayload, account: string, policy: PtbPolicy): void {
  if (payload.family !== 'sui') refuse('That is not a Sui transaction.')
  if (!isValidSuiAddress(account)) refuse('That is not a Sui address.')
  const me = normalizeSuiAddress(account)
  const data = parsePtb(payload.transaction)
  const read = readerFor(data)
  const readObject = objectReaderFor(data)

  if (typeof data.sender === 'string' && normalizeSuiAddress(data.sender) !== me) {
    refuse('This transaction would be sent from a different account than your wallet.')
  }
  const gasOwner = data.gasData.owner
  if (typeof gasOwner === 'string' && normalizeSuiAddress(gasOwner) !== me) {
    refuse('The network fee on this transaction is set to be paid by a different account.')
  }

  for (const input of data.inputs) {
    if (
      input.$kind === 'FundsWithdrawal' &&
      input.FundsWithdrawal.withdrawFrom.$kind !== 'Sender'
    ) {
      refuse('This transaction draws funds from someone other than the sender.')
    }
  }

  for (const command of data.commands) {
    switch (command.$kind) {
      case 'SplitCoins':
      case 'MergeCoins':
        break
      case 'TransferObjects':
        assertPaysAccount(read, command.TransferObjects.address, me)
        break
      case 'MoveCall': {
        const { package: pkg, module, function: fn, typeArguments } = command.MoveCall
        const target = moveTarget(pkg, module, fn)
        if (!policy.allowedCalls.has(target) && !FRAMEWORK_CALLS.has(target)) {
          refuse(
            `This transaction calls ${module}::${fn} in a contract I haven't confirmed for ${policy.venueName}. If ${policy.venueName} upgraded its contracts, this stays blocked until the new ones are checked.`
          )
        }
        const args = command.MoveCall.arguments
        if (target === SEND_FUNDS) assertPaysAccount(read, args[1], me)
        policy.checkCall?.({ target, typeArguments, arguments: args }, read, me, readObject)
        break
      }
      default:
        refuse(
          `This transaction does more than ${policy.venueName} needs (a ${command.$kind} step).`
        )
    }
  }
}
