import { erc20Abi, parseEventLogs, type Hash, type Log } from 'viem'

import { evmReader } from '../chains/evm/client'
import { EVM_NATIVE_ID } from '../chains/evm/tokens'
import { WRAP_NEAR } from '../chains/near/tokens'
import { rpc as solanaRpc } from '../chains/solana/balances'
import type { ChainToken, ChainWithActions } from '../chains/types'

/**
 * What one transaction moved for one wallet, read back from its chain by hash. Used once, for
 * transactions logged before their value was recorded at submit: see backfill-values.ts.
 *
 * Every reader comes down to the same shape: the wallet's net change in each token, by the
 * token's id in this app's tables, and what other owners gained, so a send can be told apart.
 * Each chain's native coin is folded into the id its token table gives it, so wrapping and
 * unwrapping inside one transaction nets to nothing.
 */

export interface Movement {
  ok: boolean
  /** Net change for the wallet, in base units, by token id. */
  mine: Map<string, bigint>
  /** What anyone else gained, in base units. */
  others: { token: string; owner: string; delta: bigint }[]
}

const SOL_ID = 'So11111111111111111111111111111111111111112'
const SUI_ID = '0x2::sui::SUI'

function add(map: Map<string, bigint>, token: string, delta: bigint): void {
  map.set(token, (map.get(token) ?? BigInt(0)) + delta)
}

const big = (value: unknown): bigint => {
  try {
    return BigInt(String(value ?? '0'))
  } catch {
    return BigInt(0)
  }
}

// ---- Solana -----------------------------------------------------------------------------

interface SolTokenBalance {
  accountIndex: number
  mint: string
  owner?: string
  uiTokenAmount: { amount: string }
}

interface SolTransaction {
  meta: {
    err: unknown
    fee: number
    preBalances: number[]
    postBalances: number[]
    preTokenBalances?: SolTokenBalance[]
    postTokenBalances?: SolTokenBalance[]
    loadedAddresses?: { writable?: string[]; readonly?: string[] }
  } | null
  transaction: { message: { accountKeys: (string | { pubkey: string })[] } }
}

export function solanaMovement(tx: SolTransaction, account: string): Movement {
  const meta = tx.meta
  const mine = new Map<string, bigint>()
  const others: Movement['others'] = []
  if (meta === null) return { ok: false, mine, others }
  const keys = [
    ...tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey)),
    ...(meta.loadedAddresses?.writable ?? []),
    ...(meta.loadedAddresses?.readonly ?? []),
  ]
  keys.forEach((key, i) => {
    // The first key pays the fee, which is not something the wallet sold.
    const delta =
      big(meta.postBalances[i]) - big(meta.preBalances[i]) + (i === 0 ? big(meta.fee) : BigInt(0))
    if (delta === BigInt(0)) return
    if (key === account) add(mine, SOL_ID, delta)
    else if (delta > BigInt(0)) others.push({ token: SOL_ID, owner: key, delta })
  })
  const byHolding = new Map<string, { owner: string; mint: string; delta: bigint }>()
  const note = (b: SolTokenBalance, sign: bigint): void => {
    const owner = b.owner ?? keys[b.accountIndex] ?? ''
    const key = `${owner}|${b.mint}`
    const entry = byHolding.get(key) ?? { owner, mint: b.mint, delta: BigInt(0) }
    entry.delta += sign * big(b.uiTokenAmount.amount)
    byHolding.set(key, entry)
  }
  for (const b of meta.preTokenBalances ?? []) note(b, BigInt(-1))
  for (const b of meta.postTokenBalances ?? []) note(b, BigInt(1))
  for (const { owner, mint, delta } of byHolding.values()) {
    if (delta === BigInt(0)) continue
    if (owner === account) add(mine, mint, delta)
    else if (delta > BigInt(0)) others.push({ token: mint, owner, delta })
  }
  return { ok: meta.err === null || meta.err === undefined, mine, others }
}

// ---- Sui --------------------------------------------------------------------------------

interface SuiTransaction {
  sender?: { address?: string } | null
  effects?: {
    status?: string
    balanceChanges?: {
      nodes?: {
        owner?: { address?: string } | null
        amount?: string
        coinType?: { repr?: string }
      }[]
    }
    gasEffects?: {
      gasSummary?: { computationCost?: string; storageCost?: string; storageRebate?: string }
    }
  } | null
}

/** The padded `0x000...02::sui::SUI` is `0x2::sui::SUI` in the token table. */
function suiType(repr: string): string {
  return repr.replace(/^0x0+(?=[0-9a-fA-F])/, '0x')
}

export function suiMovement(tx: SuiTransaction, account: string): Movement {
  const mine = new Map<string, bigint>()
  const others: Movement['others'] = []
  const me = account.toLowerCase()
  for (const change of tx.effects?.balanceChanges?.nodes ?? []) {
    const owner = (change.owner?.address ?? '').toLowerCase()
    const token = suiType(change.coinType?.repr ?? '')
    const delta = big(change.amount)
    if (owner === me) add(mine, token, delta)
    else if (delta > BigInt(0)) others.push({ token, owner, delta })
  }
  // Gas comes out of the sender's SUI change and is not something they sold.
  if ((tx.sender?.address ?? '').toLowerCase() === me) {
    const gas = tx.effects?.gasEffects?.gasSummary
    const cost = big(gas?.computationCost) + big(gas?.storageCost) - big(gas?.storageRebate)
    if (mine.has(SUI_ID)) add(mine, SUI_ID, cost)
  }
  return { ok: tx.effects?.status === 'SUCCESS', mine, others }
}

// ---- EVM --------------------------------------------------------------------------------

export function evmMovement(
  receipt: { status: string; logs: Log[] },
  tx: { from: string; to: string | null; value: bigint },
  account: string
): Movement {
  const mine = new Map<string, bigint>()
  const others: Movement['others'] = []
  const me = account.toLowerCase()
  if (tx.from.toLowerCase() === me && tx.value > BigInt(0)) {
    add(mine, EVM_NATIVE_ID, -tx.value)
    if (tx.to !== null)
      others.push({ token: EVM_NATIVE_ID, owner: tx.to.toLowerCase(), delta: tx.value })
  }
  for (const log of parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs })) {
    const token = log.address.toLowerCase()
    const from = log.args.from.toLowerCase()
    const to = log.args.to.toLowerCase()
    const value = log.args.value
    if (from === me) add(mine, token, -value)
    if (to === me) add(mine, token, value)
    else if (from === me) others.push({ token, owner: to, delta: value })
  }
  return { ok: receipt.status === 'success', mine, others }
}

// ---- NEAR -------------------------------------------------------------------------------

interface NearAction {
  Transfer?: { deposit: string }
  FunctionCall?: { method_name: string; deposit: string }
}

interface NearTransaction {
  status?: { Failure?: unknown } & Record<string, unknown>
  transaction?: { signer_id?: string; receiver_id?: string; actions?: (NearAction | string)[] }
  receipts_outcome?: { outcome?: { executor_id?: string; logs?: string[] } }[]
  receipts?: {
    predecessor_id?: string
    receiver_id?: string
    receipt?: { Action?: { actions?: (NearAction | string)[] } }
  }[]
}

/** Attached deposits below this are storage and one-yocto confirmations, not money sent. */
const NEAR_DUST = BigInt('10000000000000000000000')

export function nearMovement(tx: NearTransaction, account: string): Movement {
  const mine = new Map<string, bigint>()
  const others: Movement['others'] = []
  const ok = tx.status !== undefined && tx.status.Failure === undefined
  const signer = tx.transaction?.signer_id
  const receiver = tx.transaction?.receiver_id ?? ''
  if (signer === account) {
    for (const action of tx.transaction?.actions ?? []) {
      if (typeof action === 'string') continue
      if (action.Transfer !== undefined) {
        const deposit = big(action.Transfer.deposit)
        add(mine, WRAP_NEAR, -deposit)
        others.push({ token: WRAP_NEAR, owner: receiver, delta: deposit })
      } else if (action.FunctionCall !== undefined) {
        const deposit = big(action.FunctionCall.deposit)
        if (action.FunctionCall.method_name === 'near_deposit' || deposit >= NEAR_DUST) {
          add(mine, WRAP_NEAR, -deposit)
        }
      }
    }
  }
  for (const r of tx.receipts ?? []) {
    if (r.receiver_id !== account || r.predecessor_id === 'system') continue
    for (const action of r.receipt?.Action?.actions ?? []) {
      if (typeof action !== 'string' && action.Transfer !== undefined) {
        add(mine, WRAP_NEAR, big(action.Transfer.deposit))
      }
    }
  }
  for (const outcome of tx.receipts_outcome ?? []) {
    const token = outcome.outcome?.executor_id ?? ''
    for (const line of outcome.outcome?.logs ?? []) {
      if (!line.startsWith('EVENT_JSON:')) continue
      let event: { standard?: string; event?: string; data?: Record<string, string>[] }
      try {
        event = JSON.parse(line.slice('EVENT_JSON:'.length)) as typeof event
      } catch {
        continue
      }
      if (event.standard !== 'nep141') continue
      for (const d of event.data ?? []) {
        const amount = big(d['amount'])
        if (event.event === 'ft_transfer') {
          if (d['old_owner_id'] === account) add(mine, token, -amount)
          if (d['new_owner_id'] === account) add(mine, token, amount)
          else if (d['old_owner_id'] === account) {
            others.push({ token, owner: d['new_owner_id'] ?? '', delta: amount })
          }
        } else if (event.event === 'ft_mint' && d['owner_id'] === account) {
          add(mine, token, amount)
        } else if (event.event === 'ft_burn' && d['owner_id'] === account) {
          add(mine, token, -amount)
        }
      }
    }
  }
  return { ok, mine, others }
}

// ---- What it was ------------------------------------------------------------------------

export interface LookedUp {
  kind: 'swap' | 'send' | 'unknown'
  token: ChainToken
  amountIn: string
  assetOut: string | null
}

/** Native coin moved alongside another token below this is rent, gas or storage. */
const NATIVE_DUST: Record<ChainWithActions, bigint> = {
  solana: BigInt('10000000'),
  sui: BigInt('50000000'),
  near: NEAR_DUST * BigInt(5),
  avalanche: BigInt(0),
  monad: BigInt(0),
}

const NATIVE_ID: Record<ChainWithActions, string> = {
  solana: SOL_ID,
  sui: SUI_ID,
  near: WRAP_NEAR,
  avalanche: EVM_NATIVE_ID,
  monad: EVM_NATIVE_ID,
}

export function displayAmount(base: bigint, decimals: number): string {
  const negative = base < BigInt(0)
  const digits = (negative ? -base : base).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}

/**
 * What the wallet sold, and whether it was a swap (a listed token came back), a send (someone
 * else gained exactly what left) or neither. The largest listed outflow is what was sold. An
 * outflow of a token this app doesn't list can't be priced, so it is not chosen.
 */
export function describeMovement(
  chain: ChainWithActions,
  tokens: readonly ChainToken[],
  movement: Movement
): LookedUp | undefined {
  if (!movement.ok) return undefined
  const native = NATIVE_ID[chain]
  const byId = new Map(tokens.map((t) => [t.id.toLowerCase(), t]))
  const entries = [...movement.mine.entries()].filter(([, d]) => d !== BigInt(0))
  const others = entries.filter(([id]) => id.toLowerCase() !== native.toLowerCase())
  const meaningful = entries.filter(([id, d]) => {
    if (id.toLowerCase() !== native.toLowerCase() || others.length === 0) return true
    return (d < BigInt(0) ? -d : d) > NATIVE_DUST[chain]
  })
  const outs = meaningful.filter(([, d]) => d < BigInt(0))
  const ins = meaningful.filter(([, d]) => d > BigInt(0))
  const listedOuts = outs
    .map(([id, d]) => ({ token: byId.get(id.toLowerCase()), base: -d }))
    .filter((o): o is { token: ChainToken; base: bigint } => o.token !== undefined)
  if (listedOuts.length === 0) return undefined
  // Several listed outflows are rare; the one with the most units at its decimals is kept.
  const sold = listedOuts.reduce((a, b) =>
    Number(displayAmount(b.base, b.token.decimals)) >
    Number(displayAmount(a.base, a.token.decimals))
      ? b
      : a
  )
  const listedIn = ins
    .map(([id]) => byId.get(id.toLowerCase()))
    .find((t): t is ChainToken => t !== undefined)
  const sent = movement.others.some(
    (o) => o.token.toLowerCase() === sold.token.id.toLowerCase() && o.delta === sold.base
  )
  return {
    kind: listedIn !== undefined ? 'swap' : ins.length === 0 && sent ? 'send' : 'unknown',
    token: sold.token,
    amountIn: displayAmount(sold.base, sold.token.decimals),
    assetOut: listedIn?.symbol ?? null,
  }
}

// ---- Reading the chains -----------------------------------------------------------------

const LOOKUP_MS = 10_000
const SUI_GRAPHQL = 'https://graphql.mainnet.sui.io/graphql'
const NEAR_ARCHIVAL = 'https://archival-rpc.mainnet.fastnear.com'
const SUI_QUERY =
  'query($d:String!){transaction(digest:$d){sender{address} effects{status balanceChanges(first:50){nodes{owner{address} amount coinType{repr}}} gasEffects{gasSummary{computationCost storageCost storageRebate}}}}}'

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LOOKUP_MS),
  })
  if (!response.ok) throw new Error(`answered ${response.status}`)
  return response.json()
}

/** What the transaction moved for this wallet, or nothing if its chain has no record of it. */
export async function readMovement(
  chain: ChainWithActions,
  hash: string,
  account: string
): Promise<Movement | undefined> {
  switch (chain) {
    case 'solana': {
      const tx = (await solanaRpc(
        'getTransaction',
        [
          hash,
          { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' },
        ],
        AbortSignal.timeout(LOOKUP_MS)
      ).catch(() => undefined)) as SolTransaction | null | undefined
      return tx === null || tx === undefined ? undefined : solanaMovement(tx, account)
    }
    case 'sui': {
      const body = (await postJson(SUI_GRAPHQL, { query: SUI_QUERY, variables: { d: hash } })) as {
        data?: { transaction?: SuiTransaction | null }
      }
      const tx = body.data?.transaction
      return tx === null || tx === undefined ? undefined : suiMovement(tx, account)
    }
    case 'near': {
      const body = (await postJson(process.env['NEAR_ARCHIVAL_RPC_URL']?.trim() || NEAR_ARCHIVAL, {
        jsonrpc: '2.0',
        id: 'intent',
        method: 'EXPERIMENTAL_tx_status',
        params: { tx_hash: hash, sender_account_id: account, wait_until: 'NONE' },
      })) as { result?: NearTransaction }
      return body.result === undefined ? undefined : nearMovement(body.result, account)
    }
    case 'avalanche':
    case 'monad': {
      const client = evmReader(chain)
      const [receipt, tx] = await Promise.all([
        client.getTransactionReceipt({ hash: hash as Hash }),
        client.getTransaction({ hash: hash as Hash }),
      ])
      return evmMovement(receipt, tx, account)
    }
  }
}
