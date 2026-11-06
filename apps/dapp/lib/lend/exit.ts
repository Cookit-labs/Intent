import { stellarNetwork } from '@intent/config'
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'

import type { BlendBalance, BlendPositions } from './position'
import { READ_ONLY_SOURCE, blendSymbol, blendXlm } from './reserves'

/**
 * Getting money back out of Blend: where it is, and how much to ask for.
 *
 * "Withdraw 25 XLM" names an asset and not a form, and the pool keeps a plain
 * supply and collateral in separate maps, each with its own request type. So the
 * position is read and the right one chosen here. Anything that cannot be done
 * is refused in plain words before a transaction exists.
 */

const NOTHING_MOVED = 'Nothing was signed or sent.'

export interface ExitAsk {
  /** The reserve's contract id, when the caller has it. */
  assetId?: string
  /** A ticker, when a person typed one. */
  symbol?: string
  /** Base units. Omitted means all of it. */
  amount?: string
}

export type WithdrawSource = 'supply' | 'collateral'

export type WithdrawPlan =
  | {
      assetId: string
      symbol: string
      from: WithdrawSource | 'both'
      /** Base units. Omitted empties what `from` names. */
      amount?: string
      supplied?: BlendBalance
      collateral?: BlendBalance
    }
  | { refusal: string }

function matches(balance: BlendBalance, ask: ExitAsk): boolean {
  if (ask.assetId !== undefined) return balance.assetId === ask.assetId
  return balance.symbol.toUpperCase() === (ask.symbol ?? '').toUpperCase()
}

function nameOf(ask: ExitAsk): string {
  if (ask.symbol !== undefined) return ask.symbol.toUpperCase()
  return ask.assetId !== undefined ? blendSymbol(ask.assetId) : 'that asset'
}

function shown(balance: BlendBalance): string {
  return `${Number(balance.amount) / 1e7} ${balance.symbol}`
}

/** Which of the pool's two forms a withdrawal comes from, or why it cannot go ahead. */
export function planWithdraw(
  positions: BlendPositions,
  ask: ExitAsk & { from?: WithdrawSource }
): WithdrawPlan {
  const supplied = positions.supplied.find((b) => matches(b, ask))
  const collateral = positions.collateral.find((b) => matches(b, ask))
  const name = nameOf(ask)

  const held = ask.from === 'supply' ? supplied : ask.from === 'collateral' ? collateral : undefined
  if (ask.from !== undefined && held === undefined) {
    return {
      refusal: `You have no ${name} ${ask.from === 'supply' ? 'supplied' : 'as collateral'} in Blend. ${NOTHING_MOVED}`,
    }
  }

  const first = supplied ?? collateral
  if (first === undefined) {
    return {
      refusal: `You have no ${name} in Blend, so there is nothing to withdraw from there. To send USDC to your bank, say "cash out 5 USDC". ${NOTHING_MOVED}`,
    }
  }

  const base = {
    assetId: first.assetId,
    symbol: first.symbol,
    ...(supplied !== undefined ? { supplied } : {}),
    ...(collateral !== undefined ? { collateral } : {}),
  }

  if (ask.amount === undefined) {
    if (ask.from !== undefined) return { ...base, from: ask.from }
    return {
      ...base,
      from:
        supplied !== undefined && collateral !== undefined
          ? 'both'
          : first === supplied
            ? 'supply'
            : 'collateral',
    }
  }

  const wanted = BigInt(ask.amount)
  if (ask.from !== undefined) {
    if (wanted > BigInt((held as BlendBalance).amount)) {
      return {
        refusal: `You have ${shown(held as BlendBalance)} there, less than you asked to withdraw. ${NOTHING_MOVED}`,
      }
    }
    return { ...base, from: ask.from, amount: ask.amount }
  }

  if (supplied !== undefined && wanted <= BigInt(supplied.amount)) {
    return { ...base, from: 'supply', amount: ask.amount }
  }
  if (collateral !== undefined && wanted <= BigInt(collateral.amount)) {
    return { ...base, from: 'collateral', amount: ask.amount }
  }
  if (supplied !== undefined && collateral !== undefined) {
    return {
      refusal: `You have ${shown(supplied)} supplied and ${shown(collateral)} as collateral in Blend, and one withdrawal takes from one of them. Withdraw less, or say "withdraw all ${first.symbol}". ${NOTHING_MOVED}`,
    }
  }
  return {
    refusal: `You have ${shown(first)} in Blend, less than you asked to withdraw. Say "withdraw all ${first.symbol}" to take all of it. ${NOTHING_MOVED}`,
  }
}

/** The debt a repayment is for, or why there is none. */
export function findDebt(
  positions: BlendPositions,
  ask: ExitAsk
): BlendBalance | { refusal: string } {
  const owed = positions.borrowed.find((b) => matches(b, ask))
  if (owed !== undefined) return owed
  return {
    refusal: `You owe no ${nameOf(ask)} in Blend, so there is nothing to repay. ${NOTHING_MOVED}`,
  }
}

/**
 * What a transaction must ask for to clear a debt whatever it grows to first.
 *
 * Interest accrues until the moment it settles, up to three minutes after this
 * is built. One part in ten thousand covers that at a rate far beyond any this
 * pool charges, and the hundred stroops cover the rounding that left one debt
 * token behind when a simulation repaid the exact figure. The pool refunds the
 * excess in the same transaction.
 */
export function repayAllAmount(owed: bigint): bigint {
  return owed + owed / BigInt(10_000) + BigInt(100)
}

export type RepayAllPlan = { amount: string; covers: boolean } | { refusal: string }

/**
 * The most a wallet can put toward a debt, and whether that clears it.
 *
 * The pool takes the whole requested amount before refunding, so asking for more
 * than the wallet can spend fails even when the wallet could clear the debt.
 */
export function planRepayAll(owed: bigint, spendable: bigint, symbol: string): RepayAllPlan {
  if (spendable <= BigInt(0)) {
    return {
      refusal: `Your wallet has no ${symbol} free to repay with. Get some ${symbol} first, then try again. ${NOTHING_MOVED}`,
    }
  }
  const wanted = repayAllAmount(owed)
  return wanted <= spendable
    ? { amount: wanted.toString(), covers: true }
    : { amount: spendable.toString(), covers: spendable > owed }
}

/** XLM kept back from a repayment in XLM, so the wallet can still pay its fee. */
const XLM_FEE_ROOM = BigInt(5_000_000)

const STROOPS = BigInt(10_000_000)

interface HorizonAccountBalances {
  balances?: { asset_type: string; balance: string; selling_liabilities?: string }[]
  subentry_count?: number
  num_sponsoring?: number
  num_sponsored?: number
}

function stroops(display: string): bigint {
  const [whole = '0', fraction = ''] = display.split('.')
  return BigInt(whole) * STROOPS + BigInt(fraction.padEnd(7, '0').slice(0, 7))
}

/** A wallet's XLM it can actually spend: the balance, less the network's minimum and open orders. */
export function spendableXlm(account: HorizonAccountBalances): bigint {
  const native = account.balances?.find((b) => b.asset_type === 'native')
  if (native === undefined) return BigInt(0)

  const entries =
    2 + (account.subentry_count ?? 0) + (account.num_sponsoring ?? 0) - (account.num_sponsored ?? 0)
  const locked = BigInt(entries) * BigInt(5_000_000) + stroops(native.selling_liabilities ?? '0')
  const free = stroops(native.balance) - locked - XLM_FEE_ROOM
  return free > BigInt(0) ? free : BigInt(0)
}

export interface SpendableOptions {
  horizonUrl?: string
  rpcUrl?: string
  fetchImpl?: typeof fetch
}

/**
 * What the wallet can spend of a reserve's asset. Throws when it can't be read,
 * because "nothing" would become a refusal telling someone with funds they have none.
 */
export async function readSpendable(
  account: string,
  assetId: string,
  options: SpendableOptions = {}
): Promise<bigint> {
  if (assetId === blendXlm()) {
    const horizonUrl = options.horizonUrl ?? stellarNetwork.horizonUrl
    const res = await (options.fetchImpl ?? fetch)(`${horizonUrl}/accounts/${account}`, {
      headers: { Accept: 'application/json' },
    })
    if (res.status === 404) return BigInt(0)
    if (!res.ok) throw new Error(`Horizon ${res.status}`)
    return spendableXlm((await res.json()) as HorizonAccountBalances)
  }

  const server = new rpc.Server(options.rpcUrl ?? stellarNetwork.sorobanRpcUrl)
  const tx = new TransactionBuilder(new Account(READ_ONLY_SOURCE, '0'), {
    fee: BASE_FEE,
    networkPassphrase: stellarNetwork.networkPassphrase,
  })
    .addOperation(new Contract(assetId).call('balance', new Address(account).toScVal()))
    .setTimeout(60)
    .build()
  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error)
  return BigInt(String(scValToNative(sim.result?.retval as xdr.ScVal)))
}

/**
 * What a balance is worth after a call, in the asset, at the rate it was read at.
 * The map is the simulation's pool tokens by reserve index: no entry means none left.
 */
export function worthOf(
  balance: BlendBalance | undefined,
  after: Record<string, string> | undefined
): string {
  const left = balance === undefined ? undefined : after?.[String(balance.reserveIndex)]
  if (balance === undefined || left === undefined) return '0'
  const tokens = BigInt(balance.tokens)
  if (tokens <= BigInt(0)) return '0'
  return ((BigInt(balance.amount) * BigInt(left)) / tokens).toString()
}
