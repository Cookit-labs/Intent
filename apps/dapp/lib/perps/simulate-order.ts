import { stellarTestnet } from '@intent/config'
import { FeeBumpTransaction, TransactionBuilder, rpc, scValToNative } from '@stellar/stellar-sdk'
import type { xdr } from '@stellar/stellar-sdk'

/**
 * What the contract would open, read from a simulation of the prepared
 * envelope.
 *
 * The gateway's prepare returns the transaction and nothing about the
 * position: no entry price, no liquidation price. But the market contract's
 * `open_position` *returns* the `Position` it creates, with both figures
 * computed by the contract at the current oracle price. Simulating the
 * envelope against the RPC yields that struct without signing anything, so
 * the review card can show the liquidation price the contract itself would
 * set rather than one this app derived from a maintenance margin it cannot
 * read (the market exposes no config getter).
 *
 * It is a simulation, and said as one: the oracle moves between review and
 * inclusion, so the figures are "about", not a quote.
 */

export interface SimulatedOpen {
  /** 7-decimal base units, as the contract stores them. */
  entryPrice: string
  liquidationPrice: string
  size: string
  collateral: string
}

export type SimulateOutcome = { ok: true; retval?: xdr.ScVal } | { ok: false; error: string }

/** Injected in tests; the RPC one below in routes. */
export type Simulate = (xdr: string) => Promise<SimulateOutcome>

export function createRpcSimulate(rpcUrl: string = stellarTestnet.sorobanRpcUrl): Simulate {
  const server = new rpc.Server(rpcUrl)
  return async (envelope) => {
    const tx = TransactionBuilder.fromXDR(envelope, stellarTestnet.networkPassphrase)
    if (tx instanceof FeeBumpTransaction) return { ok: false, error: 'fee bump' }
    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim)) return { ok: false, error: sim.error }
    const retval = sim.result?.retval
    return { ok: true, ...(retval !== undefined ? { retval } : {}) }
  }
}

export async function readSimulatedOpen(
  envelope: string,
  simulate: Simulate
): Promise<{ ok: true; position: SimulatedOpen } | { ok: false; reason: string }> {
  let outcome: SimulateOutcome
  try {
    outcome = await simulate(envelope)
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'simulation failed' }
  }
  if (!outcome.ok) return { ok: false, reason: outcome.error }
  if (outcome.retval === undefined) {
    return { ok: false, reason: 'the simulation returned no position' }
  }

  let decoded: unknown
  try {
    decoded = scValToNative(outcome.retval)
  } catch {
    return { ok: false, reason: 'the returned position could not be read' }
  }
  // The Rust struct's field names, as `scValToNative` renders a map.
  const struct = decoded as Record<string, unknown> | null
  if (struct === null || typeof struct !== 'object' || Array.isArray(struct)) {
    return { ok: false, reason: 'the simulation did not return a position' }
  }
  const fields = ['entry_price', 'liquidation_price', 'size', 'collateral'] as const
  for (const f of fields) {
    if (typeof struct[f] !== 'bigint') {
      return { ok: false, reason: `the simulation did not return a position (${f} missing)` }
    }
  }
  return {
    ok: true,
    position: {
      entryPrice: (struct.entry_price as bigint).toString(),
      liquidationPrice: (struct.liquidation_price as bigint).toString(),
      size: (struct.size as bigint).toString(),
      collateral: (struct.collateral as bigint).toString(),
    },
  }
}
