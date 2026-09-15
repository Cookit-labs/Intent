import { stellarTestnet } from '@intent/config'
import {
  Address,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'

import { BLEND_POOL } from '../swap/contract-registry'
import { BLEND_XLM, readReserve } from './reserves'

/**
 * What an account holds in the Blend pool, in the asset it supplied.
 *
 * The pool stores a position as **bTokens**, not as XLM. A bToken is a claim on
 * a growing pot: `b_rate` rises every ledger as borrowers pay interest, so the
 * same bToken balance is worth more XLM tomorrow than today. Reporting the raw
 * bToken figure would show a number that never moves while the position quietly
 * earns, and reporting it as if it were XLM would understate the balance by
 * whatever has accrued since the supply.
 *
 * So the conversion is the point of this module: `bTokens * b_rate` at twelve
 * decimals, which is the v2 scaling. (v1 used seven, and reading v2 at v1's
 * decimals is exactly the mistake that once put this app's APY out by 100x.)
 */

/** `b_rate` and `d_rate` are twelve-decimal fixed point in Blend v2. */
const RATE_SCALAR = BigInt('1000000000000')

export interface BlendPosition {
  /** The reserve's asset contract. */
  assetId: string
  symbol: string
  /** The raw pool balance, in bTokens. */
  bTokens: string
  /** What those bTokens are worth right now, in stroops of the asset. */
  amount: string
  /** Human-readable, for display. */
  display: string
}

export interface ReadPositionOptions {
  rpcUrl?: string
  networkPassphrase?: string
}

/**
 * Simulating a read needs a source account, and any funded account will do —
 * `get_positions` takes the account it reports on as an argument rather than
 * reading the invoker. The account being asked about is therefore always a
 * valid choice and needs no separate key.
 */
async function simulate(server: rpc.Server, account: string, passphrase: string): Promise<unknown> {
  const source = await server.getAccount(account)
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(new Contract(BLEND_POOL).call('get_positions', new Address(account).toScVal()))
    .setTimeout(60)
    .build()

  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(sim.error)
  }
  return scValToNative(sim.result?.retval as xdr.ScVal)
}

/**
 * The account's XLM supply in Blend, or null if it has none.
 *
 * Only the supply is read. Collateral and liabilities are deliberately ignored:
 * this app cannot open either, so reporting them would describe positions it
 * did not create and cannot close.
 */
export async function readBlendPosition(
  account: string,
  options: ReadPositionOptions = {}
): Promise<BlendPosition | null> {
  const rpcUrl = options.rpcUrl ?? stellarTestnet.sorobanRpcUrl
  const passphrase = options.networkPassphrase ?? Networks.TESTNET
  const server = new rpc.Server(rpcUrl)

  const positions = (await simulate(server, account, passphrase)) as
    | { supply?: Record<string, bigint | number | string> }
    | undefined

  const supply = positions?.supply
  if (supply === undefined) return null

  // Keyed by reserve *index*, not by asset id. XLM is index 0 in this pool,
  // confirmed against `get_reserve_list` rather than assumed — an index read
  // as an address would silently report the wrong reserve.
  const raw = supply['0']
  if (raw === undefined) return null

  const bTokens = BigInt(String(raw))
  if (bTokens <= BigInt(0)) return null

  const reserve = await readReserve(BLEND_XLM, { rpcUrl })
  const bRate = BigInt(reserve.data.bRate)
  const amount = (bTokens * bRate) / RATE_SCALAR

  return {
    assetId: BLEND_XLM,
    symbol: 'XLM',
    bTokens: bTokens.toString(),
    amount: amount.toString(),
    display: (Number(amount) / 1e7).toFixed(7),
  }
}
