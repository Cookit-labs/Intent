const DEFAULT_RPC_URL = 'https://free.rpc.fastnear.com'
const VIEW_TIMEOUT_MS = 8_000
const TX_ATTEMPT_TIMEOUT_MS = 8_000
const TX_POLL_INTERVAL_MS = 1_500

export class NearRpcError extends Error {}

function rpcUrl(): string {
  const configured = process.env['NEAR_RPC_URL']?.trim()
  return configured === undefined || configured === '' ? DEFAULT_RPC_URL : configured
}

async function rpcCall(
  method: string,
  params: unknown,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown> {
  const response = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'intent', method, params }),
    signal:
      signal === undefined
        ? AbortSignal.timeout(timeoutMs)
        : AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]),
  })
  if (!response.ok) throw new NearRpcError(`rpc responded ${response.status}`)
  const body = (await response.json()) as {
    result?: unknown
    error?: { cause?: { name?: string }; name?: string; message?: string }
  }
  if (body.error !== undefined) {
    throw new NearRpcError(body.error.cause?.name ?? body.error.name ?? 'rpc_error')
  }
  return body.result
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

export type TxOutcome =
  /** `signer` is who the action ran as: the sender of a delegate action, if the wallet used one. */
  | { state: 'success'; signer: string; receiver: string; calls: ExecutedCall[] }
  | { state: 'failed'; signer: string; receiver: string; calls: ExecutedCall[] }
  /** Not seen as finished before the wait ended. Says nothing about whether it will succeed. */
  | { state: 'unknown' }

interface RawAction {
  FunctionCall?: { method_name: string; args: string; deposit: string }
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

function readOutcome(result: RawTxResult): TxOutcome {
  const { status, transaction } = result
  if (transaction === undefined || typeof status !== 'object' || status === null) {
    return { state: 'unknown' }
  }
  const delegate = transaction.actions.flatMap((a) =>
    typeof a !== 'string' && a.Delegate !== undefined ? [a.Delegate.delegate_action] : []
  )[0]
  const facts =
    delegate !== undefined
      ? {
          signer: delegate.sender_id,
          receiver: delegate.receiver_id,
          calls: callsOf(
            delegate.actions.map((a) =>
              'NonDelegateAction' in a && a.NonDelegateAction !== undefined
                ? a.NonDelegateAction
                : (a as RawAction)
            )
          ),
        }
      : {
          signer: transaction.signer_id,
          receiver: transaction.receiver_id,
          calls: callsOf(transaction.actions),
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
