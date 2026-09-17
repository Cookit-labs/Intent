import { stellarTestnet } from '@intent/config'
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  FeeBumpTransaction,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'

import { resolveVerifiedAsset } from './asset-registry'
import type { ClassicAsset } from './assets'
import { sacFor } from './build-soroban'
import { AQUARIUS_ROUTER } from './sources/aquarius-quoter'

/**
 * Swapping through Aquarius's router.
 *
 * A fourth builder, kept separate for the reason the other three are: each
 * asserts the exact shape it produces, and admitting a second contract into
 * `build-soroban`'s assertion would loosen what that assertion proves. The
 * two routers also differ in ways that would make a shared builder a trap —
 * `u128` where Soroswap takes `i128`, a pool index Soroswap has no concept
 * of, and a recipient in the first argument rather than the fourth.
 *
 * **The recipient is `user`, and it is asserted.** Aquarius's `swap` pays
 * `token_out` to whatever address is passed as `user`, so a substituted first
 * argument would take the signer's `token_in` and deliver the proceeds to a
 * stranger. The value is read back out of the encoded bytes rather than
 * trusted from the inputs, as with every builder here.
 *
 * **The pool index is required, and it is the quoted one.** XLM/USDC has
 * three pools with different depth, and the agent compared and chose one.
 * A builder that re-derived "the best pool" at signing time could execute a
 * different route than the one that won the competition, silently. So the
 * index travels with the quote and this refuses to build without it.
 */

/** Matches the other builders, so a wallet prompt does not linger. */
const TIMEOUT_SECONDS = 180

export interface BuildAquariusSwapOptions {
  /** The account spending, and the only account that may receive. */
  account: string
  from: ClassicAsset
  to: ClassicAsset
  /** Base units (stroops). A string, never a number. */
  sendAmount: string
  /** The floor the router must clear, in base units. */
  minReceive: string
  /** Hex of the 32-byte pool index the quote came from. */
  poolIndex: string
  routerId?: string
  horizonUrl?: string
  fetchImpl?: typeof fetch
}

export interface BuiltAquariusSwap {
  xdr: string
  /** Echoed back and asserted: the account receiving the proceeds. */
  recipient: string
  minReceive: string
  sendAmount: string
  poolIndex: string
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

/** The router wants its pair in address order; which side is first depends on the pair. */
function sortedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

function poolIndexBytes(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('an Aquarius swap needs the 32-byte pool index its quote came from')
  }
  return Buffer.from(hex, 'hex')
}

export async function buildAquariusSwap(
  options: BuildAquariusSwapOptions
): Promise<BuiltAquariusSwap> {
  const { account, from, to, sendAmount, minReceive, poolIndex } = options
  const routerId = options.routerId ?? AQUARIUS_ROUTER
  const horizonUrl = options.horizonUrl ?? stellarTestnet.horizonUrl
  const fetchImpl = options.fetchImpl ?? fetch

  if (BigInt(sendAmount) <= BigInt(0)) {
    throw new Error('a swap needs a positive amount')
  }
  if (BigInt(minReceive) < BigInt(0)) {
    throw new Error('a minimum received must be positive')
  }
  const index = poolIndexBytes(poolIndex)

  // The allowlist is the real check on the assets. A SAC id can be derived
  // for any well-formed asset, so deriving one proves nothing about whether
  // it should be traded.
  for (const asset of [from, to]) {
    if (resolveVerifiedAsset(asset.code) === undefined) {
      throw new Error(`no Soroban contract for ${asset.code}: it is not a verified asset`)
    }
  }

  let fromContract: string
  let toContract: string
  try {
    fromContract = sacFor(from)
    toContract = sacFor(to)
  } catch {
    throw new Error(`no Soroban contract for ${from.code} or ${to.code}`)
  }

  const sequence = await loadSequence(account, horizonUrl, fetchImpl)

  // Stated once, here, and asserted below.
  const recipient = account

  const pair = sortedPair(fromContract, toContract)

  const operation = new Contract(routerId).call(
    'swap',
    new Address(recipient).toScVal(),
    xdr.ScVal.scvVec(pair.map((c) => new Address(c).toScVal())),
    new Address(fromContract).toScVal(),
    new Address(toContract).toScVal(),
    xdr.ScVal.scvBytes(index),
    // u128, not i128. The router's spec says so, and the wrong type fails in
    // simulation with an error that mentions neither.
    nativeToScVal(BigInt(sendAmount), { type: 'u128' }),
    nativeToScVal(BigInt(minReceive), { type: 'u128' })
  )

  const tx = new TransactionBuilder(new Account(account, sequence), {
    fee: BASE_FEE,
    networkPassphrase: stellarTestnet.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(TIMEOUT_SECONDS)
    .build()

  const built = tx.toXDR()
  assertSelfAquariusSwap(built, account)

  return {
    xdr: built,
    recipient,
    minReceive,
    sendAmount,
    poolIndex,
    networkPassphrase: stellarTestnet.networkPassphrase,
  }
}

/**
 * Re-reads the built transaction and refuses anything that is not a lone
 * Aquarius `swap` paying this account.
 *
 * Stricter than `assertSelfInvoke` by two checks, because this router's
 * shape allows two more substitutions. The function must be `swap` — the
 * router also exposes `swap_chained`, which takes a different argument
 * layout, and a call narrated as a swap must be one. And the first argument
 * must be the signer, since that is who the router pays.
 */
export function assertSelfAquariusSwap(built: string, account: string): void {
  const decoded = TransactionBuilder.fromXDR(built, stellarTestnet.networkPassphrase)

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

  const hostFunction = (op as unknown as { func?: { type?: string; invokeContract?: unknown } })
    .func
  if (hostFunction?.type !== 'hostFunctionTypeInvokeContract') {
    throw new Error('refusing to sign: this is not a contract invocation')
  }

  const invocation = hostFunction.invokeContract as
    | { functionName?: unknown; args?: xdr.ScVal[] }
    | undefined
  if (invocation === undefined) throw new Error('refusing to sign: the call could not be read')

  // `functionName` decodes to an `XdrString`. `String()` is the honest way to
  // read it; `Buffer.from()` on it silently yields zero bytes.
  if (String(invocation.functionName) !== 'swap') {
    throw new Error(
      `refusing to sign: ${String(invocation.functionName)} is not an Aquarius swap. ` +
        'Only swap may be built here.'
    )
  }

  const args = invocation.args ?? []
  if (args.length !== 7) {
    throw new Error(
      `refusing to sign: an Aquarius swap takes seven arguments, found ${args.length}`
    )
  }

  const user = args[0]
  if (user === undefined) throw new Error('refusing to sign: the swap names no recipient')
  const recipient = Address.fromScVal(user).toString()
  if (recipient !== account) {
    throw new Error(
      `refusing to sign: the swap pays ${recipient}, not the signing account. ` +
        'An Aquarius swap must pay the account that funds it.'
    )
  }

  // Decoded rather than inspected through the XDR union: this SDK build's
  // `ScVal` instances do not expose `.switch()`, and `scValToNative` hands a
  // `scvBytes` back as bytes and anything else back as something that is not.
  const index = args[4] === undefined ? undefined : (scValToNative(args[4]) as unknown)
  if (!(index instanceof Uint8Array) || index.length !== 32) {
    throw new Error('refusing to sign: the swap names no 32-byte pool index')
  }
}
