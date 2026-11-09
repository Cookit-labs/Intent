/**
 * Free RPCs rate limit by address, and one Rhea prepare costs about 12 reads, so one alone answered
 * 429 in the middle of a swap. Measured 9 November 2026: dRPC passed all 30 Rhea live checks when
 * FastNEAR was refusing, while Lava answered 410 and 1RPC failed them all.
 */
const PUBLIC_RPC_URLS = ['https://free.rpc.fastnear.com', 'https://near.drpc.org']
const VIEW_TIMEOUT_MS = 8_000
/** A read waits this long on an RPC with another behind it, inside the shortest budget that reads. */
const FAILOVER_ATTEMPT_MS = 2_500
/** What each byte of an account's storage holds back, set by the protocol. */
const YOCTO_PER_STORAGE_BYTE = BigInt('10000000000000000000')
/** Errors about the node that answered. Another node can still answer. */
const NODE_TROUBLE: ReadonlySet<string> = new Set([
  'TIMEOUT_ERROR',
  'INTERNAL_ERROR',
  'UNAVAILABLE_SHARD',
  'NO_SYNCED_BLOCKS',
  'GARBAGE_COLLECTED_BLOCK',
  'UNKNOWN_BLOCK',
])
const TX_ATTEMPT_TIMEOUT_MS = 8_000
const TX_POLL_INTERVAL_MS = 1_500

export class NearRpcError extends Error {}

function rpcUrls(): string[] {
  const configured = process.env['NEAR_RPC_URL']?.trim()
  return configured === undefined || configured === ''
    ? PUBLIC_RPC_URLS
    : [configured, ...PUBLIC_RPC_URLS.filter((url) => url !== configured)]
}

interface RpcBody {
  result?: unknown
  error?: { cause?: { name?: string }; name?: string; message?: string }
}

/**
 * One call, asked of each RPC until one answers. An RPC that refuses, can't be reached or reports
 * trouble of its own says nothing about the chain, so the next is asked. Any other error in an
 * answer is the chain speaking, and every RPC would repeat it.
 */
export async function rpcCall(
  method: string,
  params: unknown,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown> {
  let failure: unknown
  const urls = rpcUrls()
  for (const [index, url] of urls.entries()) {
    const attemptMs =
      method === 'query' && index < urls.length - 1
        ? Math.min(timeoutMs, FAILOVER_ATTEMPT_MS)
        : timeoutMs
    let body: RpcBody
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'intent', method, params }),
        signal:
          signal === undefined
            ? AbortSignal.timeout(attemptMs)
            : AbortSignal.any([AbortSignal.timeout(attemptMs), signal]),
      })
      if (!response.ok) {
        failure = new NearRpcError(`rpc responded ${response.status}`)
        continue
      }
      body = (await response.json()) as RpcBody
    } catch (e) {
      if (signal?.aborted === true) throw e
      failure = e
      continue
    }
    if (body.error !== undefined) {
      const error = new NearRpcError(body.error.cause?.name ?? body.error.name ?? 'rpc_error')
      if (!NODE_TROUBLE.has(error.message)) throw error
      failure = error
      continue
    }
    return body.result
  }
  throw failure
}

/** A read-only contract call. Throws `NearRpcError` when the network or the contract answers badly. */
export async function viewCall<T>(
  contract: string,
  method: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal
): Promise<T> {
  const result = (await rpcCall(
    'query',
    {
      request_type: 'call_function',
      finality: 'final',
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    },
    VIEW_TIMEOUT_MS,
    signal
  )) as { result?: number[]; error?: string }
  if (!Array.isArray(result.result)) {
    throw new NearRpcError(result.error ?? 'view call returned nothing')
  }
  return JSON.parse(Buffer.from(result.result).toString('utf8')) as T
}

/** Whether an account has paid for storage on a NEP-141 or NEP-145 contract. */
export async function isRegistered(contract: string, account: string): Promise<boolean> {
  const balance = await viewCall<unknown>(contract, 'storage_balance_of', { account_id: account })
  return balance !== null
}

export interface ExecutedCall {
  method: string
  args: Record<string, unknown>
  deposit: string
}

interface ExecutedFacts {
  /** Who the action ran as: the sender of a delegate action, if the wallet used one. */
  signer: string
  receiver: string
  calls: ExecutedCall[]
  /** Yocto moved by each plain Transfer. Only a send of native NEAR reads this. */
  transfers?: string[]
}

export type TxOutcome =
  | ({ state: 'success' } & ExecutedFacts)
  | ({ state: 'failed' } & ExecutedFacts)
  /** Not seen as finished before the wait ended. Says nothing about whether it will succeed. */
  | { state: 'unknown' }

interface RawAction {
  FunctionCall?: { method_name: string; args: string; deposit: string }
  Transfer?: { deposit: string }
  Delegate?: { delegate_action: RawDelegate }
}

interface RawDelegate {
  sender_id: string
  receiver_id: string
  actions: (RawAction | { NonDelegateAction?: RawAction })[]
}

interface RawTxResult {
  status?: Record<string, unknown> | string
  transaction?: { signer_id: string; receiver_id: string; actions: (RawAction | string)[] }
}

function parseArgs(encoded: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function callsOf(actions: (RawAction | string)[]): ExecutedCall[] {
  return actions.flatMap((action) => {
    if (typeof action === 'string' || action.FunctionCall === undefined) return []
    const { method_name, args, deposit } = action.FunctionCall
    return [{ method: method_name, args: parseArgs(args), deposit }]
  })
}

function transfersOf(actions: (RawAction | string)[]): string[] {
  return actions.flatMap((action) =>
    typeof action === 'string' || action.Transfer === undefined ? [] : [action.Transfer.deposit]
  )
}

function readOutcome(result: RawTxResult): TxOutcome {
  const { status, transaction } = result
  if (transaction === undefined || typeof status !== 'object' || status === null) {
    return { state: 'unknown' }
  }
  const delegate = transaction.actions.flatMap((a) =>
    typeof a !== 'string' && a.Delegate !== undefined ? [a.Delegate.delegate_action] : []
  )[0]
  const inner = delegate?.actions.map((a) =>
    'NonDelegateAction' in a && a.NonDelegateAction !== undefined
      ? a.NonDelegateAction
      : (a as RawAction)
  )
  const facts: ExecutedFacts =
    delegate !== undefined && inner !== undefined
      ? {
          signer: delegate.sender_id,
          receiver: delegate.receiver_id,
          calls: callsOf(inner),
          transfers: transfersOf(inner),
        }
      : {
          signer: transaction.signer_id,
          receiver: transaction.receiver_id,
          calls: callsOf(transaction.actions),
          transfers: transfersOf(transaction.actions),
        }
  if ('Failure' in status) return { state: 'failed', ...facts }
  if ('SuccessValue' in status) return { state: 'success', ...facts }
  return { state: 'unknown' }
}

/** Polls the `tx` method until the transaction finishes or the wait ends. Never throws. */
export async function waitForTransaction(
  hash: string,
  senderAccount: string,
  waitMs: number
): Promise<TxOutcome> {
  const giveUpAt = Date.now() + waitMs
  while (Date.now() < giveUpAt) {
    try {
      const result = (await rpcCall(
        'tx',
        { tx_hash: hash, sender_account_id: senderAccount, wait_until: 'EXECUTED_OPTIMISTIC' },
        Math.min(TX_ATTEMPT_TIMEOUT_MS, Math.max(giveUpAt - Date.now(), 1))
      )) as RawTxResult
      const outcome = readOutcome(result)
      if (outcome.state !== 'unknown') return outcome
    } catch {
      // Not indexed yet, a timeout or a brief RPC failure: all of them mean look again.
    }
    await new Promise((resolve) => setTimeout(resolve, TX_POLL_INTERVAL_MS))
  }
  return { state: 'unknown' }
}

/** Yocto of NEAR an account holds in total, storage included, read at final. */
export async function accountBalance(account: string, signal?: AbortSignal): Promise<string> {
  const result = (await rpcCall(
    'query',
    { request_type: 'view_account', finality: 'final', account_id: account },
    VIEW_TIMEOUT_MS,
    signal
  )) as { amount?: unknown }
  if (typeof result.amount !== 'string') throw new NearRpcError('account balance unreadable')
  return result.amount
}

/**
 * Yocto of NEAR an account can move. Its balance also pays for its storage, and a transfer that
 * dips into that fails, so what storage needs comes off, less anything staked that already covers it.
 */
export async function spendableBalance(account: string, signal?: AbortSignal): Promise<string> {
  const result = (await rpcCall(
    'query',
    { request_type: 'view_account', finality: 'final', account_id: account },
    VIEW_TIMEOUT_MS,
    signal
  )) as { amount?: unknown; locked?: unknown; storage_usage?: unknown }
  if (typeof result.amount !== 'string') throw new NearRpcError('account balance unreadable')
  const held = BigInt(result.amount)
  const locked = typeof result.locked === 'string' ? BigInt(result.locked) : BigInt(0)
  const bytes = typeof result.storage_usage === 'number' ? BigInt(result.storage_usage) : BigInt(0)
  const storage = bytes * YOCTO_PER_STORAGE_BYTE
  const short = storage > locked ? storage - locked : BigInt(0)
  return (held > short ? held - short : BigInt(0)).toString()
}
