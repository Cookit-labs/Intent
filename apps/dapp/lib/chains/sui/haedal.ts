import { bcs } from '@mysten/sui/bcs'
import { coinWithBalance, Transaction, type TransactionArgument } from '@mysten/sui/transactions'
import { fromBase64, normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils'

import {
  ChainActionRefused,
  takesOnly,
  toBaseUnits,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
  type SigningPayload,
  type VenueQuote,
} from '../types'
import { assertSuiAccount, buildUnsigned, suiClient, withTimeout } from './client'
import { assertPtbSafe, moveTarget, type ParsedCall, type PtbPolicy, type ReadPure } from './safety'
import { displayAmount } from './tokens'

/**
 * Latest package and the Staking object: github.com/haedallsd/haedal-protocol-interface README.
 * On chain, UpgradeCap 0xc1c6690f...2f25 names this package at version 8, Staking is a shared
 * `0xbde4ba4c...::staking::Staking`, and live unstakes call this package. An upgrade fails closed:
 * the old package aborts on `assert_version`, and a new id isn't allowed here.
 */
export const HAEDAL_PACKAGE = '0x126e4cfb051cad744706df590ec399e8c02b6feae195c35b8b496280d5442a62'
export const HAEDAL_STAKING = '0x47b224762220393057ebf4f70501b6e657c3e56684737568439a04f80849b2ca'
/** Same README's original package. On chain, coin metadata 0x84f24e39...57f3 says haSUI, 9 decimals. */
export const HASUI_TYPE =
  '0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI'

export const HAEDAL_TOKENS: ChainToken[] = [
  { symbol: 'haSUI', id: HASUI_TYPE, decimals: 9, name: 'Haedal Staked SUI' },
]

export const SUI_SYSTEM_STATE = '0x5'
const SUI_DECIMALS = 9
const HASUI_DECIMALS = 9
const DRY_RUN_TIMEOUT_MS = 15_000
const READ_TIMEOUT_MS = 10_000
/** The contract's own floor, for a stake and for the SUI value of an unstake: bytecode constant 0. */
const MIN_SUI = BigInt('1000000000')
/** `request_unstake_instant_coin` divides `service_fee` by this: bytecode constant 4. */
const FEE_SCALE = 10_000_000
/** The README: 0x0 leaves the validator to Haedal. */
const NO_VALIDATOR = normalizeSuiAddress('0x0')

const REQUEST_STAKE = moveTarget(HAEDAL_PACKAGE, 'staking', 'request_stake_coin')
const REQUEST_UNSTAKE = moveTarget(HAEDAL_PACKAGE, 'staking', 'request_unstake_instant_coin')

function fail(reason: string): never {
  throw new ChainActionRefused(`${reason} Nothing was signed or sent.`)
}

type TxInput = ReturnType<Transaction['getData']>['inputs'][number]

function objectIdOf(input: TxInput | undefined): string | undefined {
  if (input?.$kind === 'UnresolvedObject') return input.UnresolvedObject.objectId
  if (input?.$kind !== 'Object') return undefined
  const object = input.Object
  if (object.$kind === 'SharedObject') return object.SharedObject.objectId
  if (object.$kind === 'ImmOrOwnedObject') return object.ImmOrOwnedObject.objectId
  return undefined
}

/**
 * A policy's `checkCall` reads only literals, so the objects a call names are checked here. Per
 * argument, the object it must be, or undefined for one that isn't pinned, like the person's coin.
 * Run after `assertPtbSafe`, which has already refused bytes that don't parse.
 */
export function assertPinnedObjects(
  payload: SigningPayload,
  pins: ReadonlyMap<string, readonly (string | undefined)[]>,
  venueName: string
): void {
  if (payload.family !== 'sui') fail('That is not a Sui transaction.')
  const data = Transaction.from(fromBase64(payload.transaction)).getData()
  for (const command of data.commands) {
    if (command.$kind !== 'MoveCall') continue
    const { package: pkg, module, function: fn, arguments: args } = command.MoveCall
    const pinned = pins.get(moveTarget(pkg, module, fn))
    if (pinned === undefined) continue
    if (args.length !== pinned.length) {
      fail(`This transaction calls ${module}::${fn} in a way ${venueName} doesn't.`)
    }
    pinned.forEach((expected, index) => {
      if (expected === undefined) return
      const argument = args[index]
      const id = argument?.$kind === 'Input' ? objectIdOf(data.inputs[argument.Input]) : undefined
      if (id === undefined || normalizeSuiAddress(id) !== normalizeSuiAddress(expected)) {
        fail(`This transaction uses an object I haven't confirmed for ${venueName}.`)
      }
    })
  }
}

/** Reads an address literal, or nothing when it isn't one. */
export function readAddress(read: ReadPure, argument: Parameters<ReadPure>[0]): string | undefined {
  const bytes = read(argument)
  if (bytes === undefined) return undefined
  try {
    return normalizeSuiAddress(bcs.Address.parse(bytes))
  } catch {
    return undefined
  }
}

/** Dry-runs built bytes, which moves nothing. */
export function dryRun(transaction: string, what: string) {
  return withTimeout(
    suiClient().core.simulateTransaction({
      transaction: fromBase64(transaction),
      include: { balanceChanges: true, commandResults: true },
    }),
    DRY_RUN_TIMEOUT_MS,
    what
  )
}

/** How much of a coin a dry run paid this account, in base units. */
export function creditedAmount(
  changes: readonly { coinType: string; address: string; amount: string }[] | undefined,
  coinType: string,
  account: string
): string | undefined {
  const paid = changes?.find(
    (c) =>
      normalizeStructTag(c.coinType) === normalizeStructTag(coinType) &&
      normalizeSuiAddress(c.address) === normalizeSuiAddress(account)
  )
  return paid !== undefined && /^\d+$/.test(paid.amount) && BigInt(paid.amount) > BigInt(0)
    ? paid.amount
    : undefined
}

const COIN = bcs.struct('Coin', { id: bcs.Address, value: bcs.u64() })

/**
 * The value of the coin a call returned in a dry run, in base units. A balance change won't do for
 * SUI: it is mixed with the gas paid and with storage rebates, which can be larger than either.
 */
export function returnedCoinAmount(
  results: readonly { returnValues: readonly { bcs: Uint8Array | null }[] }[] | undefined,
  transaction: string,
  target: string
): string | undefined {
  const { commands } = Transaction.from(fromBase64(transaction)).getData()
  const index = commands.findIndex(
    (c) =>
      c.$kind === 'MoveCall' &&
      moveTarget(c.MoveCall.package, c.MoveCall.module, c.MoveCall.function) === target
  )
  const bytes = index < 0 ? undefined : results?.[index]?.returnValues[0]?.bcs
  if (bytes === undefined || bytes === null) return undefined
  try {
    const { value } = COIN.parse(bytes)
    return BigInt(value) > BigInt(0) ? value : undefined
  } catch {
    return undefined
  }
}

/** The u64 a public read function returns, from a dry run with no gas or signature, or nothing. */
export async function readU64(
  account: string,
  target: string,
  args: (tx: Transaction) => TransactionArgument[]
): Promise<bigint | undefined> {
  const tx = new Transaction()
  tx.setSender(account)
  tx.moveCall({ target, arguments: args(tx) })
  const simulated = await withTimeout(
    suiClient().core.simulateTransaction({
      transaction: tx,
      include: { commandResults: true },
      checksEnabled: false,
    }),
    DRY_RUN_TIMEOUT_MS,
    'Reading the contract'
  )
  const bytes = simulated.commandResults?.[0]?.returnValues[0]?.bcs
  if (bytes === undefined || bytes === null) return undefined
  try {
    return BigInt(bcs.u64().parse(bytes))
  } catch {
    return undefined
  }
}

/** An object's fields as the chain reports them, or nothing. */
export async function readObjectJson(id: string): Promise<Record<string, unknown> | undefined> {
  const { objects } = await withTimeout(
    suiClient().core.getObjects({ objectIds: [id], include: { json: true } }),
    READ_TIMEOUT_MS,
    'Reading the contract'
  )
  const object = objects[0]
  if (object === undefined || object instanceof Error) return undefined
  return object.json ?? undefined
}

/** A u64 from an object's fields, which the chain gives as digits. */
export function u64Field(value: unknown): bigint | undefined {
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : undefined
}

/** A rate for a card: 0.02, 0.34. Rounded to what a person can use, never to zero. */
export function percentText(percent: number): string {
  const text = percent.toFixed(2).replace(/\.?0+$/, '')
  return text === '0' ? 'under 0.01' : text
}

/** `assertCanFollow` for a venue that stakes SUI and can also unstake, which never follows a swap. */
export function stakesAfterSwap(venueName: string): NonNullable<ChainVenue['assertCanFollow']> {
  const takesSui = takesOnly(venueName, ['SUI'])
  return async (step, account) => {
    if (step.kind !== 'stake') fail(`${venueName} can only stake after a swap.`)
    await takesSui(step, account)
  }
}

async function readFees(): Promise<{ serviceFee: number; rewardFee: number }> {
  const staking = await readObjectJson(HAEDAL_STAKING)
  const config = staking?.['config'] as Record<string, unknown> | undefined
  const serviceFee = u64Field(config?.['service_fee'])
  const rewardFee = u64Field(config?.['reward_fee'])
  if (serviceFee === undefined || rewardFee === undefined) {
    fail("I couldn't read Haedal's fees, so I stopped. Try again shortly.")
  }
  return {
    serviceFee: (Number(serviceFee) / FEE_SCALE) * 100,
    rewardFee: (Number(rewardFee) / FEE_SCALE) * 100,
  }
}

async function checkedStake(request: ChainActionRequest, account: string) {
  assertSuiAccount(account)
  if (request.tokenIn.trim().toUpperCase() !== 'SUI') {
    throw new ChainActionRefused(
      `Haedal stakes SUI, not ${request.tokenIn}. Try "stake 1 SUI with Haedal".`
    )
  }
  const amount = toBaseUnits(request.amount, SUI_DECIMALS)
  if (BigInt(amount) < MIN_SUI) fail('Haedal stakes at least 1 SUI.')

  const tx = new Transaction()
  tx.setSender(account)
  const [sui] = tx.splitCoins(tx.gas, [BigInt(amount)])
  if (sui === undefined) throw new Error('Splitting a coin returned nothing.')
  const [minted] = tx.moveCall({
    target: REQUEST_STAKE,
    arguments: [
      tx.object(SUI_SYSTEM_STATE),
      tx.object(HAEDAL_STAKING),
      sui,
      tx.pure.address(NO_VALIDATOR),
    ],
  })
  if (minted === undefined) throw new Error('Staking returned nothing.')
  tx.transferObjects([minted], account)

  const transaction = await buildUnsigned(tx, suiClient(), 'SUI')
  const simulated = await dryRun(transaction, 'Checking the stake')
  const received = creditedAmount(simulated.Transaction?.balanceChanges, HASUI_TYPE, account)
  if (received === undefined) {
    fail(
      "I couldn't confirm how much haSUI this stake would return, so I stopped. Try again shortly."
    )
  }
  return { transaction, receive: displayAmount(received, HASUI_DECIMALS) }
}

async function checkedUnstake(request: ChainActionRequest, account: string) {
  assertSuiAccount(account)
  if (request.tokenIn.trim().toUpperCase() !== 'HASUI') {
    throw new ChainActionRefused(
      `Haedal unstakes haSUI, not ${request.tokenIn}. Try "unstake 1 haSUI with Haedal".`
    )
  }
  const amount = toBaseUnits(request.amount, HASUI_DECIMALS)
  const value = await readU64(
    account,
    moveTarget(HAEDAL_PACKAGE, 'staking', 'get_sui_by_stsui'),
    (tx) => [tx.object(HAEDAL_STAKING), tx.pure.u64(BigInt(amount))]
  )
  if (value === undefined) {
    fail("I couldn't read what this haSUI is worth, so I stopped. Try again shortly.")
  }
  if (value < MIN_SUI) fail('Haedal unstakes at least 1 SUI worth of haSUI.')

  const tx = new Transaction()
  tx.setSender(account)
  const coin = tx.add(
    coinWithBalance({ type: HASUI_TYPE, balance: BigInt(amount), useGasCoin: false })
  )
  const [sui] = tx.moveCall({
    target: REQUEST_UNSTAKE,
    arguments: [tx.object(SUI_SYSTEM_STATE), tx.object(HAEDAL_STAKING), coin],
  })
  if (sui === undefined) throw new Error('Unstaking returned nothing.')
  tx.transferObjects([sui], account)

  const transaction = await buildUnsigned(tx, suiClient(), 'haSUI')
  const simulated = await dryRun(transaction, 'Checking the unstake')
  const received = returnedCoinAmount(simulated.commandResults, transaction, REQUEST_UNSTAKE)
  if (received === undefined) {
    fail(
      "I couldn't confirm how much SUI this unstake would return, so I stopped. Try again shortly."
    )
  }
  return { transaction, receive: displayAmount(received, SUI_DECIMALS) }
}

const SHARED_RISKS = [
  'Your SUI sits in contracts a Haedal admin multisig can upgrade. That admin can also change the fees and pause staking, unstaking and claims.',
  "Haedal's vaults are reported to have lost about $915K in June 2026, with staking reportedly not affected. I could not confirm this from a primary source. This uses staking, not the vaults.",
]

/** No apyPercent: no rate can be read from Haedal here, and a rate is never invented. */
async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
  const { receive } = await checkedStake(request, account)
  return { receive: { amount: receive, symbol: 'haSUI' } }
}

async function prepareStake(request: ChainActionRequest, account: string): Promise<PreparedAction> {
  const { transaction, receive } = await checkedStake(request, account)
  const { serviceFee, rewardFee } = await readFees()
  return {
    venueId: 'haedal',
    venueName: 'Haedal',
    kind: 'stake',
    summary: `Stake ${request.amount} SUI with Haedal for about ${receive} haSUI.`,
    pay: { amount: request.amount, symbol: 'SUI' },
    receive: { amount: receive, symbol: 'haSUI', approximate: true },
    notes: [
      `Staking rewards are not guaranteed. They depend on the validators, and Haedal keeps ${percentText(rewardFee)}% of them. I am not showing a rate because I could not read one from Haedal.`,
      'haSUI is worth more than SUI over time, so you get fewer of them, and it can trade below its value on the market.',
      `To get out, unstake here. The SUI comes back in the same transaction for a fee of ${percentText(serviceFee)}%, if Haedal can free that much SUI at the time. The minimum is 1 SUI worth.`,
      ...SHARED_RISKS,
    ],
    signing: { family: 'sui', transaction },
  }
}

async function prepareUnstake(
  request: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  const { transaction, receive } = await checkedUnstake(request, account)
  const { serviceFee } = await readFees()
  return {
    venueId: 'haedal',
    venueName: 'Haedal',
    kind: 'unstake',
    summary: `Unstake ${request.amount} haSUI with Haedal for about ${receive} SUI, right away.`,
    pay: { amount: request.amount, symbol: 'haSUI' },
    receive: { amount: receive, symbol: 'SUI', approximate: true },
    notes: [
      `This is Haedal's instant unstake: there is no wait, and the SUI is in your wallet once this lands. The fee is ${percentText(serviceFee)}%, already taken off the amount shown.`,
      "Haedal also has a free unstake that waits one or two epochs, then needs a separate claim. This app doesn't build that one, so it stays on Haedal's own site.",
      ...SHARED_RISKS,
    ],
    signing: { family: 'sui', transaction },
  }
}

const PINS: ReadonlyMap<string, readonly (string | undefined)[]> = new Map([
  [REQUEST_STAKE, [SUI_SYSTEM_STATE, HAEDAL_STAKING, undefined, undefined]],
  [REQUEST_UNSTAKE, [SUI_SYSTEM_STATE, HAEDAL_STAKING, undefined]],
])

function checkHaedalCall(call: ParsedCall, read: ReadPure): void {
  if (call.target !== REQUEST_STAKE && call.target !== REQUEST_UNSTAKE) return
  if (call.typeArguments.length > 0) fail('This Haedal call names a token it should not.')
  if (call.target === REQUEST_STAKE && readAddress(read, call.arguments[3]) !== NO_VALIDATOR) {
    fail('This stake names a validator I did not choose.')
  }
}

export const HAEDAL_POLICY: PtbPolicy = {
  venueName: 'Haedal',
  allowedCalls: new Set([REQUEST_STAKE, REQUEST_UNSTAKE]),
  checkCall: checkHaedalCall,
}

/** On hold: built and tested, but not registered in the Sui module or listed. */
export const haedalVenue: ChainVenue = {
  id: 'haedal',
  name: 'Haedal',
  kinds: ['stake', 'unstake'],
  assertCanFollow: stakesAfterSwap('Haedal'),
  quote,
  prepare: (request, account) =>
    request.kind === 'unstake' ? prepareUnstake(request, account) : prepareStake(request, account),
  assertSafe: (payload: SigningPayload, account: string) => {
    assertPtbSafe(payload, account, HAEDAL_POLICY)
    assertPinnedObjects(payload, PINS, 'Haedal')
  },
}
