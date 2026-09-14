import { stellarTestnet } from '@intent/config'
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  FeeBumpTransaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'

import { BLEND_POOL } from '../swap/contract-registry'

/**
 * Supplying to Blend.
 *
 * A fourth builder, separate for the same reason the Soroswap one is: each
 * asserts the shape it produces, and widening an assertion to admit another
 * shape weakens the guarantee it exists to make.
 *
 * **The recipient is the risk here, as it is with the router.** Blend's
 * `submit` takes three addresses, and the pool credits the position to whatever
 * `to` names. A supply that credits somebody else is a gift wearing a deposit's
 * clothes, so all three are pinned to the signer and read back out of the
 * encoded bytes rather than trusted from the arguments.
 *
 * Borrowing is deliberately absent. A supply-only position cannot be
 * liquidated — the pool never checks health on a supply, and it panics outright
 * when asked to open a liquidation auction against an account with no
 * liabilities. That guarantee holds only while nothing here can open one.
 */

/**
 * Supply, in Blend's request enum.
 *
 * Type 2 is `SupplyCollateral`, which also earns yield but backs borrowing.
 * For a yield-only feature 0 is both correct and the safer default: it cannot
 * become collateral for a liability the user did not ask for.
 */
const REQUEST_TYPE_SUPPLY = 0

const TIMEOUT_SECONDS = 180

export interface BuildSupplyOptions {
  /** The account supplying, and the only account that may be credited. */
  account: string
  /** The reserve's asset, as a contract id. Read from the pool, never derived. */
  asset: string
  /** Base units. A string, never a number. */
  amount: string
  poolId?: string
  horizonUrl?: string
  rpcUrl?: string
  fetchImpl?: typeof fetch
}

export interface BuiltSupply {
  xdr: string
  /** Echoed back and asserted: the account credited with the position. */
  recipient: string
  asset: string
  amount: string
  networkPassphrase: string
}

/**
 * One entry in Blend's `requests` vector.
 *
 * **Soroban serialises struct fields alphabetically**, so the wire order is
 * `address, amount, request_type` even though the Rust source declares
 * `request_type` first. `nativeToScVal` with a type map handles that; a
 * hand-rolled `scvMap` written in source order would encode a struct the pool
 * cannot read, and the failure would surface as an opaque simulation error
 * rather than anything naming field order.
 */
function supplyRequest(asset: string, amount: string): xdr.ScVal {
  return nativeToScVal(
    {
      address: new Address(asset),
      amount: BigInt(amount),
      request_type: REQUEST_TYPE_SUPPLY,
    },
    {
      type: {
        address: ['symbol', 'address'],
        amount: ['symbol', 'i128'],
        request_type: ['symbol', 'u32'],
      },
    }
  )
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
    throw new Error('This account is not funded yet, so it cannot supply.')
  }
  if (!res.ok) throw new Error(`Horizon ${res.status}`)

  const body = (await res.json()) as { sequence?: string }
  if (body.sequence === undefined) throw new Error('Horizon returned no sequence number')
  return body.sequence
}

/**
 * Builds an unsigned supply.
 *
 * Its own transaction rather than a step inside a shared envelope, because
 * **Soroban permits exactly one operation per transaction**. Verified on
 * testnet twice: a path payment beside a contract call is refused, and so are
 * two contract calls. A swap and a supply therefore cannot share a signature,
 * which is a protocol fact rather than a limitation of this code.
 */
export async function buildBlendSupply(options: BuildSupplyOptions): Promise<BuiltSupply> {
  const { account, asset, amount } = options
  const poolId = options.poolId ?? BLEND_POOL
  const horizonUrl = options.horizonUrl ?? stellarTestnet.horizonUrl
  const fetchImpl = options.fetchImpl ?? fetch

  if (BigInt(amount) <= BigInt(0)) {
    throw new Error('a supply needs a positive amount')
  }

  const sequence = await loadSequence(account, horizonUrl, fetchImpl)

  // Stated once, here, and asserted below. `from` spends, `spender` authorises,
  // `to` is credited — and the pool will happily credit a third party, which is
  // exactly why this is not a parameter.
  const recipient = account

  const operation = new Contract(poolId).call(
    'submit',
    new Address(account).toScVal(),
    new Address(account).toScVal(),
    new Address(recipient).toScVal(),
    xdr.ScVal.scvVec([supplyRequest(asset, amount)])
  )

  const tx = new TransactionBuilder(new Account(account, sequence), {
    fee: BASE_FEE,
    networkPassphrase: stellarTestnet.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(TIMEOUT_SECONDS)
    .build()

  const built = tx.toXDR()
  assertSelfSupply(built, account)

  return {
    xdr: built,
    recipient,
    asset,
    amount,
    networkPassphrase: stellarTestnet.networkPassphrase,
  }
}

/**
 * Re-reads the built transaction and refuses anything that is not a lone supply
 * crediting this account.
 *
 * The three addresses are checked individually. Two of three being the signer
 * is not close enough: `to` alone decides who ends up holding the position, so
 * a transaction correct in every other respect can still hand the deposit away.
 */
export function assertSelfSupply(built: string, account: string): void {
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

  // `functionName` decodes to an `XdrString`, not a plain string and not a byte
  // array. `Buffer.from()` on it silently yields zero bytes.
  if (String(invocation.functionName) !== 'submit') {
    throw new Error(
      `refusing to sign: ${String(invocation.functionName)} is not a supply. ` +
        'Only submit may be built here.'
    )
  }

  const args = invocation.args ?? []
  if (args.length !== 4) {
    throw new Error(`refusing to sign: a supply takes four arguments, found ${args.length}`)
  }

  const NAMES = ['from', 'spender', 'to']
  NAMES.forEach((name, index) => {
    const arg = args[index]
    if (arg === undefined) {
      throw new Error(`refusing to sign: the supply has no ${name} address`)
    }
    const address = Address.fromScVal(arg).toString()
    if (address !== account) {
      throw new Error(
        `refusing to sign: the supply names ${address} as ${name}, not the signing account. ` +
          'A supply must credit the account that funds it.'
      )
    }
  })
}

/**
 * Simulates the supply, which Soroban requires before submission.
 *
 * More than an estimate, and worth doing for the second reason alone: it
 * surfaces an exceeded supply cap, a disabled reserve, or an insufficient
 * balance *before* the user is asked to sign, rather than as an on-chain
 * failure they have already paid a fee for.
 */
export async function prepareBlendSupply(
  built: string,
  rpcUrl: string = stellarTestnet.sorobanRpcUrl
): Promise<{ ok: true; xdr: string; bTokens?: string } | { ok: false; reason: string }> {
  const server = new rpc.Server(rpcUrl)

  let tx
  try {
    tx = TransactionBuilder.fromXDR(built, stellarTestnet.networkPassphrase)
  } catch {
    return { ok: false, reason: 'The transaction could not be read.' }
  }
  if (tx instanceof FeeBumpTransaction) {
    return { ok: false, reason: 'Fee-bump transactions are not supported.' }
  }

  try {
    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim)) {
      // The pool's own revert reason, which distinguishes "cap reached" from
      // "not enough balance" far better than a generic failure would.
      return { ok: false, reason: sim.error }
    }

    const prepared = rpc.assembleTransaction(tx, sim).build()
    const result: { ok: true; xdr: string; bTokens?: string } = {
      ok: true,
      xdr: prepared.toXDR(),
    }

    const bTokens = readSuppliedTokens(sim)
    if (bTokens !== undefined) result.bTokens = bTokens

    return result
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'Simulation failed.' }
  }
}

/**
 * How many bTokens the supply would mint, from the simulated result.
 *
 * **Approximate, and it cannot be made exact.** Interest accrues every ledger,
 * so three identical simulations of the same 10 XLM returned three different
 * figures. Blend's `submit` takes no minimum-out, so unlike a swap there is no
 * floor to set — which is why anything built on this must say "about".
 */
function readSuppliedTokens(sim: rpc.Api.SimulateTransactionSuccessResponse): string | undefined {
  try {
    const positions = scValToNative(sim.result?.retval as xdr.ScVal) as
      | { supply?: Record<string, unknown> }
      | undefined

    const supply = positions?.supply
    if (supply === undefined) return undefined

    const first = Object.values(supply)[0]
    return first === undefined ? undefined : String(first)
  } catch {
    return undefined
  }
}
