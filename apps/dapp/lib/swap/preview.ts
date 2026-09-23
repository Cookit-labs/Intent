import {
  Address,
  Asset,
  FeeBumpTransaction,
  StrKey,
  TransactionBuilder,
  scValToNative,
  type rpc,
  type xdr,
} from '@stellar/stellar-sdk'

import { fromBaseUnits, toBaseUnits } from './assets'

/**
 * What the user's wallet will look like after signing, stated before signing.
 *
 * An agent's reasoning describes a plan; the transaction is the plan. This
 * reads the transaction, not the description, and says what will move.
 *
 * Two bases, and the card says which:
 *
 * - `derived`: a classic transaction carries its amounts in the operations,
 *   and the network enforces the floors (`destMin`) and ceilings (`sendMax`).
 *   Reading them off the operations is a guarantee, not an estimate.
 * - `simulated`: a Soroban invocation keeps its amounts inside a contract, so
 *   the network's own simulation of the call is asked what ledger entries
 *   change, and the user's balances are read out of the answer.
 *
 * Nothing here comes from the agent. That is the point.
 */

export interface BalanceChange {
  /** Asset code, or the token contract id when no known asset matches. */
  code: string
  /** Signed decimal, `-20` or `+108.3`. Never zero. */
  delta: string
  /**
   * `exact` when the operation fixes the amount; `at_least` for a floor the
   * network enforces; `at_most` for a ceiling or a commitment that may not
   * all be used.
   */
  bound: 'exact' | 'at_least' | 'at_most'
  /** One line when the change needs a word beyond its sign. */
  note?: string
}

export interface LedgerPreview {
  basis: 'derived' | 'simulated'
  changes: BalanceChange[]
  /** The whole transaction fee, in XLM. */
  feeXlm: string
  /**
   * Who pays it. `sponsor` when the app wraps the transaction in a fee-bump
   * at submission, in which case nothing leaves the wallet for the fee.
   */
  feePaidBy?: 'sponsor' | 'account'
  /** Operations the derivation could not read. Zero on a simulated preview. */
  unresolved: number
}

/** A token contract the app can name. */
export interface KnownToken {
  code: string
  contract: string
}

/** Stellar's base reserve per ledger entry, which a new trustline costs. */
const TRUSTLINE_RESERVE_XLM = '0.5'

function codeOf(asset: Asset): string {
  return asset.isNative() ? 'XLM' : asset.getCode()
}

interface Pending {
  code: string
  stroops: bigint
  bound: BalanceChange['bound']
  note?: string
}

/**
 * Same asset, same bound, same note: one line. Two payments of XLM are one
 * debit; a floor and an exact debit of the same asset stay separate because
 * they mean different things.
 */
function merge(pending: Pending[]): BalanceChange[] {
  const order: string[] = []
  const totals = new Map<string, Pending>()
  for (const p of pending) {
    const key = `${p.code}|${p.bound}|${p.note ?? ''}`
    const seen = totals.get(key)
    if (seen === undefined) {
      totals.set(key, { ...p })
      order.push(key)
    } else {
      seen.stroops += p.stroops
    }
  }
  const out: BalanceChange[] = []
  for (const key of order) {
    const p = totals.get(key) as Pending
    if (p.stroops === BigInt(0)) continue
    const sign = p.stroops > BigInt(0) ? '+' : '-'
    const magnitude = p.stroops > BigInt(0) ? p.stroops : -p.stroops
    out.push({
      code: p.code,
      delta: `${sign}${plain(magnitude)}`,
      bound: p.bound,
      ...(p.note !== undefined ? { note: p.note } : {}),
    })
  }
  return out
}

function stroops(amount: string): bigint {
  return BigInt(toBaseUnits(amount))
}

/**
 * Stroops as a decimal a person reads: `20`, not `20.0000000`. The seven
 * places are the ledger's precision, not information about this amount.
 */
export function plain(amount: bigint): string {
  return fromBaseUnits(amount.toString()).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1')
}

/**
 * Reads a classic transaction's operations for what they do to `account`.
 *
 * Operations whose source is another account are somebody else's business
 * and are skipped; a Soroban invocation is counted as unresolved rather than
 * guessed at, because its amounts live inside the contract.
 */
export function derivePreview(
  envelope: string,
  account: string,
  passphrase: string
): LedgerPreview {
  const parsed = TransactionBuilder.fromXDR(envelope, passphrase)
  const tx = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed
  const pending: Pending[] = []
  let unresolved = 0

  for (const op of tx.operations) {
    const source = op.source ?? tx.source
    if (source !== account) continue

    switch (op.type) {
      case 'payment':
        pending.push({ code: codeOf(op.asset), stroops: -stroops(op.amount), bound: 'exact' })
        if (op.destination === account) {
          pending.push({ code: codeOf(op.asset), stroops: stroops(op.amount), bound: 'exact' })
        }
        break

      case 'pathPaymentStrictSend':
        pending.push({
          code: codeOf(op.sendAsset),
          stroops: -stroops(op.sendAmount),
          bound: 'exact',
        })
        if (op.destination === account) {
          pending.push({
            code: codeOf(op.destAsset),
            stroops: stroops(op.destMin),
            bound: 'at_least',
          })
        }
        break

      case 'pathPaymentStrictReceive':
        pending.push({
          code: codeOf(op.sendAsset),
          stroops: -stroops(op.sendMax),
          bound: 'at_most',
        })
        if (op.destination === account) {
          pending.push({
            code: codeOf(op.destAsset),
            stroops: stroops(op.destAmount),
            bound: 'exact',
          })
        }
        break

      case 'manageSellOffer':
      case 'createPassiveSellOffer':
        // Nothing leaves until the order fills; what the ledger does now is
        // hold the amount against the account so it cannot be spent twice.
        if (stroops(op.amount) > BigInt(0)) {
          pending.push({
            code: codeOf(op.selling),
            stroops: -stroops(op.amount),
            bound: 'at_most',
            note: 'committed to an open order until it fills or is cancelled',
          })
        }
        break

      case 'manageBuyOffer':
        if (stroops(op.buyAmount) > BigInt(0)) {
          // The selling side is buyAmount × price; the price is a rational the
          // SDK has already rendered as a decimal string.
          const selling = (Number(op.buyAmount) * Number(op.price)).toFixed(7)
          pending.push({
            code: codeOf(op.selling),
            stroops: -stroops(selling),
            bound: 'at_most',
            note: 'committed to an open order until it fills or is cancelled',
          })
        }
        break

      case 'changeTrust': {
        const line = op.line
        const removing = op.limit === '0'
        const name = line instanceof Asset ? codeOf(line) : 'liquidity pool'
        pending.push({
          code: 'XLM',
          stroops: removing ? stroops(TRUSTLINE_RESERVE_XLM) : -stroops(TRUSTLINE_RESERVE_XLM),
          bound: 'exact',
          note: removing
            ? `reserve released by closing the ${name} trustline`
            : `held as reserve for the ${name} trustline`,
        })
        break
      }

      case 'liquidityPoolDeposit':
        pending.push({
          code: 'liquidity pool',
          stroops: -stroops(op.maxAmountA),
          bound: 'at_most',
          note: 'deposited as pool liquidity, first asset',
        })
        pending.push({
          code: 'liquidity pool',
          stroops: -stroops(op.maxAmountB),
          bound: 'at_most',
          note: 'deposited as pool liquidity, second asset',
        })
        break

      default:
        unresolved += 1
    }
  }

  return {
    basis: 'derived',
    changes: merge(pending),
    feeXlm: plain(BigInt(tx.fee)),
    unresolved,
  }
}

function contractOf(scAddress: xdr.ScAddress): string {
  return Address.fromScAddress(scAddress).toString()
}

/**
 * The SDK's XDR values are discriminated objects: a union carries `type` and
 * the arm's fields under `value`; a struct is its fields. These readers name
 * the two shapes this preview cares about and return zero for anything else,
 * so an entry of an unexpected kind is ignored rather than crashing a card.
 */
function balanceOf(entry: xdr.LedgerEntry | null): bigint {
  if (entry === null) return BigInt(0)
  const data = entry.data
  if (data.type !== 'contractData') return BigInt(0)
  const native = scValToNative(data.value.val) as { amount?: bigint } | undefined
  return typeof native?.amount === 'bigint' ? native.amount : BigInt(0)
}

function accountBalanceOf(entry: xdr.LedgerEntry | null): bigint {
  if (entry === null) return BigInt(0)
  const data = entry.data
  if (data.type !== 'account') return BigInt(0)
  return BigInt(String(data.value.balance))
}

function accountOfKey(id: xdr.PublicKey): string | undefined {
  // The SDK wraps the 32 key bytes in a typed value; the bytes are `.value`.
  const wrapped = (id as unknown as { ed25519?: { value?: Uint8Array } }).ed25519
  const raw = wrapped?.value
  return raw === undefined ? undefined : StrKey.encodeEd25519PublicKey(Buffer.from(raw))
}

/**
 * Reads the user's balance deltas out of a simulation's ledger changes.
 *
 * A token balance on Soroban is a contract-data entry keyed
 * `["Balance", <address>]` under the token's contract, holding `{ amount }`.
 * The native balance, when the call touches it directly, is the account
 * entry itself. Everything else the call changes — pool reserves, the
 * counterparty's balance, contract bookkeeping — is not the user's and is
 * left out.
 */
export function simulatedPreview(
  sim: rpc.Api.SimulateTransactionSuccessResponse,
  account: string,
  known: KnownToken[],
  feeXlm: string
): LedgerPreview {
  const pending: Pending[] = []
  const byContract = new Map(known.map((k) => [k.contract, k.code]))

  for (const change of sim.stateChanges ?? []) {
    const key = change.key

    if (key.type === 'contractData') {
      const data = key.value
      const parts = scValToNative(data.key) as unknown
      if (!Array.isArray(parts) || parts[0] !== 'Balance' || parts[1] !== account) continue
      const contract = contractOf(data.contract)
      const delta = balanceOf(change.after) - balanceOf(change.before)
      pending.push({ code: byContract.get(contract) ?? contract, stroops: delta, bound: 'exact' })
      continue
    }

    if (key.type === 'account') {
      if (accountOfKey(key.value.accountId) !== account) continue
      const delta = accountBalanceOf(change.after) - accountBalanceOf(change.before)
      pending.push({ code: 'XLM', stroops: delta, bound: 'exact' })
    }
  }

  return { basis: 'simulated', changes: merge(pending), feeXlm, unresolved: 0 }
}
