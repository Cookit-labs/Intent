import { bcs } from '@mysten/sui/bcs'
import type { SuiClientTypes } from '@mysten/sui/client'
import { Inputs, Transaction, TransactionDataBuilder } from '@mysten/sui/transactions'
import {
  fromBase64,
  isValidSuiAddress,
  normalizeStructTag,
  normalizeSuiAddress,
} from '@mysten/sui/utils'

import { buildUnsigned, suiClient, withTimeout } from '../../chains/sui/client'
import { submitSui } from '../../chains/sui/submit'
import { SUI_TOKENS } from '../../chains/sui/tokens'
import {
  ChainActionRefused,
  tokenBySymbol,
  toBaseUnits,
  type ChainToken,
  type SignedPayload,
  type SigningPayload,
  type SubmitResult,
} from '../../chains/types'
import type { DepositChain, DepositExpectation } from '../types'

type TxData = ReturnType<Transaction['getData']>
type TxCommand = TxData['commands'][number]
type TxArgument = Extract<TxCommand, { $kind: 'SplitCoins' }>['SplitCoins']['coin']

const USDC = tokenBySymbol(SUI_TOKENS, 'USDC') as ChainToken

function tokenOf(expectation: DepositExpectation): ChainToken {
  return expectation.token ?? USDC
}

function coinTypeOf(token: ChainToken): string {
  return normalizeStructTag(`0x2::coin::Coin<${token.id}>`)
}

const MAX_U64 = BigInt('18446744073709551615')
const READ_TIMEOUT_MS = 10_000
const COINS_PER_PAGE = 100
/** Five pages stays under the 511 arguments one command may take. */
const MAX_COIN_PAGES = 5

function refuse(sentence: string): never {
  throw new ChainActionRefused(`${sentence} Nothing was signed or sent.`)
}

/** Everything about the order itself, checked before any transaction is read or written. */
function orderUnits(expectation: DepositExpectation): string {
  const { account, depositAddress, memo, amount } = expectation
  if (memo !== undefined) refuse('This order has a memo, which a Sui deposit cannot carry.')
  if (!isValidSuiAddress(account)) refuse('That is not a Sui address.')
  if (!isValidSuiAddress(depositAddress))
    refuse('This order’s deposit address is not a Sui address.')
  if (normalizeSuiAddress(depositAddress) === normalizeSuiAddress(account)) {
    refuse('This order’s deposit address is your own wallet.')
  }
  const token = tokenOf(expectation)
  let units: string
  try {
    units = toBaseUnits(amount, token.decimals)
  } catch (e) {
    return refuse(e instanceof Error ? e.message : 'That is not an amount.')
  }
  if (BigInt(units) > MAX_U64) refuse(`This order’s amount is too large for ${token.symbol}.`)
  return units
}

function parse(transaction: string): TxData {
  // Only BCS bytes. The JSON form can hold unresolved values that are not what gets signed.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(transaction)) {
    refuse('I could not read this as a Sui transaction.')
  }
  try {
    return Transaction.from(fromBase64(transaction)).getData()
  } catch {
    return refuse('I could not read this as a Sui transaction.')
  }
}

function pureBytes(data: TxData, argument: TxArgument | undefined): Uint8Array | undefined {
  if (argument?.$kind !== 'Input') return undefined
  const input = data.inputs[argument.Input]
  return input?.$kind === 'Pure' ? fromBase64(input.Pure.bytes) : undefined
}

function coinInput(data: TxData, argument: TxArgument): number {
  if (argument.$kind === 'GasCoin') refuse('This transaction would spend your SUI gas coin.')
  const input = argument.$kind === 'Input' ? data.inputs[argument.Input] : undefined
  if (
    argument.$kind !== 'Input' ||
    input?.$kind !== 'Object' ||
    input.Object.$kind !== 'ImmOrOwnedObject'
  ) {
    return refuse('This transaction spends something other than an owned coin.')
  }
  return argument.Input
}

function isResultOf(argument: TxArgument | undefined, command: number): boolean {
  if (argument?.$kind === 'Result') return argument.Result === command
  return (
    argument?.$kind === 'NestedResult' &&
    argument.NestedResult[0] === command &&
    argument.NestedResult[1] === 0
  )
}

/**
 * Only this shape passes: merges into one owned coin, one split of exactly the amount,
 * and that split sent to the deposit address. Returns the object ids it spends, because
 * the bytes name a coin by id alone and only the network can say what type it is.
 */
function spentCoins(transaction: string, expectation: DepositExpectation): string[] {
  const units = orderUnits(expectation)
  const { symbol } = tokenOf(expectation)
  const me = normalizeSuiAddress(expectation.account)
  const data = parse(transaction)

  if (typeof data.sender !== 'string' || normalizeSuiAddress(data.sender) !== me) {
    refuse('This transaction would be sent from a different account than your wallet.')
  }
  const gasOwner = data.gasData.owner
  if (typeof gasOwner !== 'string' || normalizeSuiAddress(gasOwner) !== me) {
    refuse('The network fee on this transaction is set to be paid by a different account.')
  }
  if (data.inputs.some((input) => input.$kind === 'FundsWithdrawal')) {
    refuse('This transaction draws on an address balance, which a deposit does not use.')
  }

  const splitAt = data.commands.length - 2
  const split = data.commands[splitAt]
  const transfer = data.commands[splitAt + 1]
  const merges = data.commands.slice(0, Math.max(splitAt, 0))
  if (split?.$kind !== 'SplitCoins' || transfer?.$kind !== 'TransferObjects') {
    return refuse(`This transaction does more than the one ${symbol} transfer this order needs.`)
  }

  const coin = coinInput(data, split.SplitCoins.coin)
  const coins = new Set([coin])
  for (const merge of merges) {
    if (merge.$kind !== 'MergeCoins') {
      return refuse(`This transaction does more than the one ${symbol} transfer this order needs.`)
    }
    if (coinInput(data, merge.MergeCoins.destination) !== coin) {
      refuse('This transaction merges coins into something other than the coin it pays from.')
    }
    for (const source of merge.MergeCoins.sources) {
      const index = coinInput(data, source)
      if (coins.has(index)) refuse('This transaction merges the same coin twice.')
      coins.add(index)
    }
  }

  const amounts = split.SplitCoins.amounts
  const amount = amounts.length === 1 ? pureBytes(data, amounts[0]) : undefined
  if (amount?.length !== 8 || bcs.u64().parse(amount) !== units) {
    refuse('This transfer’s amount is not this order’s amount.')
  }

  const { objects, address } = transfer.TransferObjects
  if (objects.length !== 1 || !isResultOf(objects[0], splitAt)) {
    refuse('This transaction should send only the split coin.')
  }
  const recipient = pureBytes(data, address)
  if (
    recipient?.length !== 32 ||
    normalizeSuiAddress(bcs.Address.parse(recipient)) !==
      normalizeSuiAddress(expectation.depositAddress)
  ) {
    refuse('This transfer does not go to this order’s deposit address.')
  }

  // Beyond the coins, only the amount and the recipient.
  if (data.inputs.length !== coins.size + 2) {
    refuse('This transaction carries inputs a deposit does not use.')
  }
  return Array.from(coins, (index) => {
    const input = data.inputs[index]
    return normalizeSuiAddress(input?.Object?.ImmOrOwnedObject?.objectId as string)
  })
}

function assertSafe(payload: SigningPayload, expectation: DepositExpectation): void {
  if (payload.family !== 'sui') refuse('That is not a Sui transaction.')
  spentCoins(payload.transaction, expectation)
}

async function read<T>(work: Promise<T>): Promise<T> {
  try {
    return await withTimeout(work, READ_TIMEOUT_MS, 'Reading Sui')
  } catch {
    return refuse('Sui’s network could not be read just now.')
  }
}

async function coinsCovering(
  account: string,
  units: bigint,
  expectation: DepositExpectation
): Promise<SuiClientTypes.Coin[]> {
  const { core } = suiClient()
  const token = tokenOf(expectation)
  const wanted = coinTypeOf(token)
  const picked: SuiClientTypes.Coin[] = []
  let total = BigInt(0)
  let cursor: string | null = null
  for (let page = 0; page < MAX_COIN_PAGES; page += 1) {
    const reply: SuiClientTypes.ListCoinsResponse = await read(
      core.listCoins({ owner: account, coinType: token.id, limit: COINS_PER_PAGE, cursor })
    )
    for (const coin of reply.objects) {
      if (total < units && normalizeStructTag(coin.type) === wanted) {
        picked.push(coin)
        total += BigInt(coin.balance)
      }
    }
    if (total >= units) return picked
    if (!reply.hasNextPage) break
    cursor = reply.cursor
  }

  const { balance } = await read(core.getBalance({ owner: account, coinType: token.id }))
  if (BigInt(balance.balance) >= units) {
    // Weave's orders name no token, and a person there is cashing out rather than swapping.
    const action = expectation.token === undefined ? 'cash-out' : 'swap'
    refuse(
      `Your ${token.symbol} is in your Sui address balance or across too many small coins, and this ${action} can only spend coins.`
    )
  }
  return refuse(`This wallet holds less ${token.symbol} than this order’s amount.`)
}

async function build(expectation: DepositExpectation): Promise<SigningPayload> {
  const units = orderUnits(expectation)
  const me = normalizeSuiAddress(expectation.account)
  const token = tokenOf(expectation)
  const coins = await coinsCovering(me, BigInt(units), expectation)

  const tx = new Transaction()
  tx.setSender(me)
  tx.setGasOwner(me)
  const [coin, ...others] = coins.map((c) =>
    tx.object(Inputs.ObjectRef({ objectId: c.objectId, version: c.version, digest: c.digest }))
  )
  if (coin === undefined) {
    return refuse(`This wallet holds less ${token.symbol} than this order’s amount.`)
  }
  if (others.length > 0) tx.mergeCoins(coin, others)
  const [split] = tx.splitCoins(coin, [BigInt(units)])
  tx.transferObjects([split as never], normalizeSuiAddress(expectation.depositAddress))

  let transaction: string
  try {
    transaction = await buildUnsigned(tx, suiClient(), token.symbol)
  } catch (e) {
    return refuse(
      e instanceof ChainActionRefused ? e.message : 'Sui’s network could not build this just now.'
    )
  }
  const payload: SigningPayload = { family: 'sui', transaction }
  assertSafe(payload, expectation)
  return payload
}

/** What the bytes can't show: that each coin spent really is the token, and the account's own. */
async function assertSpendsOwnToken(
  ids: string[],
  account: string,
  token: ChainToken
): Promise<void> {
  const me = normalizeSuiAddress(account)
  const wanted = coinTypeOf(token)
  const { objects } = await read(suiClient().core.getObjects({ objectIds: ids }))
  const allOwn =
    objects.length === ids.length &&
    objects.every(
      (object) =>
        !(object instanceof Error) &&
        normalizeStructTag(object.type) === wanted &&
        object.owner.$kind === 'AddressOwner' &&
        normalizeSuiAddress(object.owner.AddressOwner) === me
    )
  if (!allOwn) refuse(`A coin in this transaction is not ${token.symbol} held by your wallet.`)
}

async function submit(
  signed: SignedPayload,
  expectation: DepositExpectation
): Promise<SubmitResult> {
  if (signed.family !== 'sui') {
    return { ok: false, error: 'That is not a Sui transaction, so nothing was sent.' }
  }
  const token = tokenOf(expectation)
  const ids = spentCoins(signed.transaction, expectation)
  await assertSpendsOwnToken(ids, expectation.account, token)
  try {
    const result = await submitSui({ account: expectation.account, venueId: 'weave', signed })
    // submitSui words a failure for a trade, and what failed here is only the deposit.
    return !result.ok && result.pending !== true && result.error.includes('trade')
      ? {
          ok: false,
          error: `This deposit failed on the network, so your ${token.symbol} did not move and only the network fee was spent. You can try again.`,
        }
      : result
  } catch {
    // submitSui throws only when the send's outcome is unknown, so it may have landed.
    const digest = TransactionDataBuilder.getDigestFromBytes(fromBase64(signed.transaction))
    return {
      ok: false,
      pending: true,
      error: `Your ${token.symbol} deposit was sent (${digest}) but isn't confirmed yet. Don't send it again until you've checked https://suiscan.xyz/mainnet/tx/${digest}.`,
    }
  }
}

export const suiDeposit: DepositChain = {
  chain: 'sui',
  usdcDecimals: USDC.decimals,
  supportsMemo: false,
  isAccount: isValidSuiAddress,
  isDepositAddress: isValidSuiAddress,
  usdcBalance: async (account) => {
    const { core } = suiClient()
    const { balance } = await read(core.getBalance({ owner: account, coinType: USDC.id }))
    return BigInt(balance.balance)
  },
  build,
  assertSafe,
  submit,
}
