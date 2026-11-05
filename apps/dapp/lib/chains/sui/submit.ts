import { fromBase64 } from '@mysten/sui/utils'

import type { SubmitInput, SubmitResult } from '../types'
import { suiClient } from './client'

const EXECUTE_TIMEOUT_MS = 45_000

interface ExecutedTx {
  digest: string
  effects?: { status?: { success: boolean; error?: { message: string } | null } }
}

export interface SuiExecutor {
  executeTransaction(options: {
    transaction: Uint8Array
    signatures: string[]
    include: { effects: true }
    signal: AbortSignal
  }): Promise<{ Transaction?: ExecutedTx; FailedTransaction?: ExecutedTx }>
}

/** Codes meaning the network turned it down, as opposed to not answering. */
const REJECTED_CODES = new Set(['INVALID_ARGUMENT', 'FAILED_PRECONDITION'])
const STALE_OBJECT = /not available for consumption|ObjectVersionUnavailable|locked|too old/i

/**
 * A plain outcome for a rejection that certainly didn't land, or nothing. A timeout or
 * dropped connection stays an exception, because the transaction may still have gone
 * through, and the route tells the user to check their wallet.
 */
function rejection(e: unknown): string | undefined {
  const message = e instanceof Error ? e.message : ''
  if (STALE_OBJECT.test(message)) {
    return "This wallet's coins changed after the transaction was built. Nothing moved. Please try again."
  }
  const code = (e as { code?: unknown } | undefined)?.code
  if (typeof code === 'string' && REJECTED_CODES.has(code)) {
    return 'The network rejected this transaction. Nothing moved. Please try again, and if it keeps happening, reconnect your wallet.'
  }
  return undefined
}

export async function submitSui(input: SubmitInput, executor?: SuiExecutor): Promise<SubmitResult> {
  const { signed } = input
  if (signed.family !== 'sui') return { ok: false, error: 'That is not a Sui transaction.' }

  const client: SuiExecutor = executor ?? {
    executeTransaction: (options) => suiClient().core.executeTransaction(options),
  }

  let result: Awaited<ReturnType<SuiExecutor['executeTransaction']>>
  try {
    result = await client.executeTransaction({
      transaction: fromBase64(signed.transaction),
      signatures: [signed.signature],
      include: { effects: true },
      signal: AbortSignal.timeout(EXECUTE_TIMEOUT_MS),
    })
  } catch (e) {
    const error = rejection(e)
    if (error !== undefined) return { ok: false, error }
    throw e
  }

  const executed = result.Transaction ?? result.FailedTransaction
  const status = executed?.effects?.status
  if (executed === undefined || status === undefined) {
    throw new Error('The network returned no effects for this transaction.')
  }
  if (!status.success) {
    return {
      ok: false,
      error:
        'This transaction failed on the network, so the trade did not happen and only the network fee was spent. The price may have moved. Please try again.',
    }
  }
  return {
    ok: true,
    hash: executed.digest,
    explorerUrl: `https://suiscan.xyz/mainnet/tx/${executed.digest}`,
  }
}
