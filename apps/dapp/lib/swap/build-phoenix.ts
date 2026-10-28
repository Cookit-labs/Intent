import { stellarNetwork } from '@intent/config'
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  FeeBumpTransaction,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'

import { resolveVerifiedAsset } from './asset-registry'
import type { ClassicAsset } from './assets'
import { sacFor } from './build-soroban'
import { assertVenueOn } from '../venues'

/**
 * Swapping through one Phoenix pool, called directly by its contract id.
 *
 * Phoenix has no router to call: a swap is one `invokeHostFunction` against
 * the pool contract the quote already resolved, not a router with the pool
 * as an argument. So where `build-aquarius.ts` asserts a pool *index*
 * argument matches the quote, this asserts the call *target itself* is the
 * quoted pool — the same discipline, carried by the one piece of Phoenix
 * that is actually fixed per swap.
 *
 * **The recipient is `sender`, and it is asserted.** Phoenix's pool `swap`
 * pays the ask asset to whatever address is passed as `sender` — the same
 * recipient-pinning concern as every builder here, since the value is read
 * back out of the signed bytes rather than trusted from the inputs.
 *
 * **Argument order is `sender, offer_asset, offer_amount,
 * ask_asset_min_amount, max_spread_bps, deadline, max_allowed_fee_bps`** —
 * seven arguments, read from the live Rust source
 * (`contracts/pool/src/contract.rs`, `PoolTrait::swap`) on 2026-10-28, not
 * assumed from Aquarius's own seven-argument `swap`, which is a different,
 * unrelated seven.
 */

const TIMEOUT_SECONDS = 180

export interface BuildPhoenixSwapOptions {
  /** The account spending, and the only account that may receive. */
  account: string
  from: ClassicAsset
  to: ClassicAsset
  /** Base units (stroops). A string, never a number. */
  sendAmount: string
  /** The floor the pool must clear, in base units. */
  minReceive: string
  /** The exact pool contract the quote priced. */
  poolAddress: string
  horizonUrl?: string
  fetchImpl?: typeof fetch
}

export interface BuiltPhoenixSwap {
  xdr: string
  recipient: string
  minReceive: string
  sendAmount: string
  poolAddress: string
  networkPassphrase: string
}

async function loadSequence(
  account: string,
  horizonUrl: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const res = await fetchImpl(`${horizonUrl}/accounts/${account}`, {
    headers: { Accept: 'application/json' },
  })
  if (res.status === 404) {
    throw new Error('This account is not funded yet, so it cannot swap.')
  }
  if (!res.ok) throw new Error(`Horizon ${res.status}`)

  const body = (await res.json()) as { sequence?: string }
  if (body.sequence === undefined) throw new Error('Horizon returned no sequence number')
  return body.sequence
}

export async function buildPhoenixSwap(
  options: BuildPhoenixSwapOptions
): Promise<BuiltPhoenixSwap> {
  assertVenueOn('phoenix')
  const { account, from, to, sendAmount, minReceive, poolAddress } = options
  const horizonUrl = options.horizonUrl ?? stellarNetwork.horizonUrl
  const fetchImpl = options.fetchImpl ?? fetch

  if (BigInt(sendAmount) <= BigInt(0)) {
    throw new Error('a swap needs a positive amount')
  }
  if (BigInt(minReceive) < BigInt(0)) {
    throw new Error('a minimum received must be positive')
  }
  if (poolAddress === '') {
    throw new Error('a Phoenix swap needs the pool address its quote came from')
  }

  // The allowlist is the real check on the assets. A SAC id can be derived
  // for any well-formed asset, so deriving one proves nothing about whether
  // it should be traded.
  for (const asset of [from, to]) {
    if (resolveVerifiedAsset(asset.code) === undefined) {
      throw new Error(`no Soroban contract for ${asset.code}: it is not a verified asset`)
    }
  }

  let fromContract: string
  try {
    fromContract = sacFor(from)
    sacFor(to)
  } catch {
    throw new Error(`no Soroban contract for ${from.code} or ${to.code}`)
  }

  const sequence = await loadSequence(account, horizonUrl, fetchImpl)

  // Stated once, here, and asserted below.
  const recipient = account

  const operation = new Contract(poolAddress).call(
    'swap',
    new Address(recipient).toScVal(),
    new Address(fromContract).toScVal(),
    // i128, not u128 — Phoenix's pool interface, unlike Aquarius's router.
    nativeToScVal(BigInt(sendAmount), { type: 'i128' }),
    nativeToScVal(BigInt(minReceive), { type: 'i128' }), // ask_asset_min_amount: Option<i128>
    xdr.ScVal.scvVoid(), // max_spread_bps: Option<i64>, None
    xdr.ScVal.scvVoid(), // deadline: Option<u64>, None
    xdr.ScVal.scvVoid() // max_allowed_fee_bps: Option<i64>, None
  )

  const tx = new TransactionBuilder(new Account(account, sequence), {
    fee: BASE_FEE,
    networkPassphrase: stellarNetwork.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(TIMEOUT_SECONDS)
    .build()

  const built = tx.toXDR()
  assertSelfPhoenixSwap(built, account, poolAddress)

  return {
    xdr: built,
    recipient,
    minReceive,
    sendAmount,
    poolAddress,
    networkPassphrase: stellarNetwork.networkPassphrase,
  }
}

/**
 * Re-reads the built transaction and refuses anything that is not a lone
 * Phoenix pool `swap` against the quoted pool, paying this account.
 *
 * Three checks, because Phoenix has three places a substitution could
 * hide: the call target (any of the 13-and-growing pools, or anything
 * else entirely — there is no router to narrow this to), the function
 * (`withdraw_liquidity` and `provide_liquidity` share the contract and
 * are not swaps), and the recipient (the pool pays `sender`).
 *
 * `poolAddress` omitted re-runs the function and recipient checks without
 * pinning the call target — `assertShapeOfPhoenixSwap` below is this with
 * that argument always absent, for the one caller that genuinely has no
 * quote to compare against: `venue-routing.ts`'s post-signature re-check,
 * which re-validates a signed envelope with only the account to go on, no
 * static router id to match (Phoenix has none) and no live call to make
 * (that check is synchronous everywhere it is called). This matches, not
 * loosens, what already ships for Aquarius: `assertSelfAquariusSwap`'s own
 * re-check never compares its pool index against a specific expected value
 * either — pinning to the exact quoted pool happens once, here, at build
 * time, and the re-check's job is catching a tampered shape, not proving
 * pool identity a second time.
 */
export function assertSelfPhoenixSwap(built: string, account: string, poolAddress?: string): void {
  const decoded = TransactionBuilder.fromXDR(built, stellarNetwork.networkPassphrase)

  if (decoded instanceof FeeBumpTransaction) {
    throw new Error('fee-bump transactions are not supported here')
  }
  const tx = decoded

  if (tx.source !== account) {
    throw new Error(`refusing to sign: transaction source ${tx.source} is not the account`)
  }

  if (tx.operations.length !== 1) {
    throw new Error(`expected exactly one operation, found ${tx.operations.length}`)
  }

  const op = tx.operations[0]
  if (op === undefined) throw new Error('transaction has no operation')
  if (op.type !== 'invokeHostFunction') {
    throw new Error(`operation ${op.type} is not a contract invocation`)
  }

  const hostFunction = (
    op as unknown as {
      func?: {
        type?: string
        invokeContract?: {
          contractAddress?: xdr.ScAddress
          functionName?: unknown
          args?: unknown[]
        }
      }
    }
  ).func
  if (hostFunction?.type !== 'hostFunctionTypeInvokeContract') {
    throw new Error('refusing to sign: this is not a contract invocation')
  }

  const invocation = hostFunction.invokeContract
  if (invocation === undefined) throw new Error('refusing to sign: the call could not be read')

  if (poolAddress !== undefined) {
    // `contractAddress` is a raw ScAddress, the invoked contract's own
    // address — not an ScVal argument, so Address.fromScVal (which reads an
    // argument out of a scvAddress wrapper) throws on it. Matches
    // plan-validator.ts's readContractCall, which hits this exact value.
    const calledContract =
      invocation.contractAddress !== undefined
        ? Address.fromScAddress(invocation.contractAddress).toString()
        : undefined
    if (calledContract !== poolAddress) {
      throw new Error(
        `refusing to sign: this calls ${calledContract ?? 'an unreadable contract'}, not the ` +
          `pool ${poolAddress} this quote priced. A different pool is a different trade.`
      )
    }
  }

  if (String(invocation.functionName) !== 'swap') {
    throw new Error(
      `refusing to sign: ${String(invocation.functionName)} is not a Phoenix swap. ` +
        'Only swap may be built here.'
    )
  }

  const args = (invocation.args ?? []) as Parameters<typeof Address.fromScVal>[0][]
  if (args.length !== 7) {
    throw new Error(`refusing to sign: a Phoenix swap takes seven arguments, found ${args.length}`)
  }

  const sender = args[0]
  if (sender === undefined) throw new Error('refusing to sign: the swap names no recipient')
  const recipient = Address.fromScVal(sender).toString()
  if (recipient !== account) {
    throw new Error(
      `refusing to sign: the swap pays ${recipient}, not the signing account. ` +
        'A Phoenix swap must pay the account that funds it.'
    )
  }
}

/**
 * The shape-only form of `assertSelfPhoenixSwap`, for `venue-routing.ts`'s
 * post-signature re-check — see that function's own doc comment for why
 * this does not, and should not, compare against a specific pool address.
 */
export function assertShapeOfPhoenixSwap(built: string, account: string): void {
  assertSelfPhoenixSwap(built, account)
}
