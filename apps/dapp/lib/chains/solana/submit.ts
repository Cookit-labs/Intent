import { getBase58Decoder } from '@solana/kit'
import { z } from 'zod'

import type { SubmitInput, SubmitResult } from '../types'
import { decodeSolanaTransaction } from './assert-safe'

const DEFAULT_RPC_URL = 'https://solana-rpc.publicnode.com'
const RPC_TIMEOUT_MS = 15_000
/** About 60 seconds, which is roughly how long a blockhash lasts. */
const POLL_MS = 2_000
const MAX_POLLS = 30

export function explorerUrl(hash: string): string {
  return `https://solscan.io/tx/${hash}`
}

/** The fee payer's signature as the network names it, or nothing if the wallet left it empty. */
export function feePayerSignature(signedTransaction: string): string | undefined {
  const signature = decodeSolanaTransaction(signedTransaction).feePayerSignature
  return signature === null ? undefined : getBase58Decoder().decode(signature)
}

const RpcError = z.object({
  code: z.number().optional(),
  message: z.string().optional(),
  data: z
    .object({ err: z.unknown().optional(), logs: z.array(z.string()).nullable().optional() })
    .optional(),
})

const RpcReply = z.object({ result: z.unknown().optional(), error: RpcError.optional() })

const Statuses = z.object({
  value: z.array(
    z.object({ confirmationStatus: z.string().nullable().optional(), err: z.unknown() }).nullable()
  ),
})

type Status = NonNullable<z.infer<typeof Statuses>['value'][number]>

const BlockhashValid = z.object({ value: z.boolean() })

const EXPIRED =
  'This transaction expired before it reached the network, so nothing moved. Build it again and sign right away.'

/**
 * What the network said, in a sentence, when its answer proves nothing was sent. A node
 * forwards a transaction only after preflight passes, so -32002 and the error names only
 * preflight reports are that proof. Other errors, and any wording outside -32002, could come
 * from a gateway that already passed the transaction on, so they return nothing.
 * Raw logs stay out of what the user reads.
 */
function explainSendError(error: z.infer<typeof RpcError>): string | undefined {
  const err = error.data?.err
  const logs = (error.data?.logs ?? []).join(' ').toLowerCase()
  const message = (error.message ?? '').toLowerCase()
  const preflight = error.code === -32002
  // Preflight fails this way because the same transaction is already in a block.
  if (err === 'AlreadyProcessed' || message.includes('already been processed')) return undefined
  if (err === 'BlockhashNotFound' || (preflight && message.includes('blockhash not found'))) {
    return EXPIRED
  }
  if (err === 'AccountNotFound' || err === 'InsufficientFundsForFee') {
    return 'This wallet doesn’t have enough SOL to pay the network fee, so nothing was sent. Add a little SOL and try again.'
  }
  if (!preflight) return undefined
  if (logs.includes('insufficient funds') || logs.includes('insufficient lamports')) {
    return 'This wallet’s balance is too low for this transaction, so nothing was sent. Check your balance, including a little SOL for fees, and try again.'
  }
  return 'The network’s simulation of this transaction failed, so nothing was sent. Check your balance and build it again, since prices may have moved.'
}

/**
 * The outcome a status settles, or nothing. A processed block can sit on a fork that
 * gets dropped, so neither its success nor its failure is final.
 */
function settledBy(status: Status, hash: string): SubmitResult | undefined {
  if (status.confirmationStatus !== 'confirmed' && status.confirmationStatus !== 'finalized') {
    return undefined
  }
  if (status.err !== null && status.err !== undefined) {
    return {
      ok: false,
      error: `This transaction landed but failed, so your tokens did not move. Network fees may still apply. Details: ${explorerUrl(hash)}`,
    }
  }
  return { ok: true, hash, explorerUrl: explorerUrl(hash) }
}

export interface SolanaSubmitOptions {
  env?: Record<string, string | undefined>
  pollMs?: number
  maxPolls?: number
}

/**
 * Sends signed bytes and waits, within a bound, for the network to confirm them.
 * A network failure while sending throws, because the outcome is then unknown and
 * the route tells the user to check their wallet before trying again.
 */
export function createSolanaSubmit(options: SolanaSubmitOptions = {}) {
  const env = options.env ?? process.env
  const pollMs = options.pollMs ?? POLL_MS
  const maxPolls = options.maxPolls ?? MAX_POLLS

  async function rpc(method: string, params: unknown[]): Promise<z.infer<typeof RpcReply>> {
    const url = env['SOLANA_RPC_URL']?.trim() || DEFAULT_RPC_URL
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    })
    // A node answers JSON-RPC errors with a 200. Any other status came from something
    // in between, so its body can't prove what the node did.
    if (!response.ok) throw new Error(`The RPC answered ${response.status}`)
    return RpcReply.parse(await response.json())
  }

  /** A status, `null` if the node answered and hasn't seen it, `undefined` if it didn't answer. */
  async function readStatus(hash: string, config?: object): Promise<Status | null | undefined> {
    const params = config !== undefined ? [[hash], config] : [[hash]]
    const reply = await rpc('getSignatureStatuses', params).catch(() => undefined)
    const statuses = Statuses.safeParse(reply?.result)
    return statuses.success ? statuses.data.value[0] : undefined
  }

  return async (input: SubmitInput): Promise<SubmitResult> => {
    if (input.signed.family !== 'solana') {
      return { ok: false, error: 'That is not a Solana transaction.' }
    }
    const { signedTransaction } = input.signed
    const hash = feePayerSignature(signedTransaction)
    if (hash === undefined) {
      return {
        ok: false,
        error: 'Your wallet returned this unsigned, so nothing was sent. Sign it again.',
      }
    }

    const sent = await rpc('sendTransaction', [
      signedTransaction,
      { encoding: 'base64', preflightCommitment: 'confirmed' },
    ])
    if (sent.error !== undefined) {
      const refusal = explainSendError(sent.error)
      if (refusal !== undefined) return { ok: false, error: refusal }
      return {
        ok: false,
        pending: true,
        error: `The network’s answer doesn’t show whether this went out, so it may still go through. Don’t send it again until you’ve checked ${explorerUrl(hash)}.`,
      }
    }

    // A read that went unanswered may have missed the transaction landing, and one that
    // saw it means it reached a block. Either way, later silence no longer proves anything.
    let mayHaveLanded = false
    for (let poll = 0; poll < maxPolls; poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, pollMs))
      const status = await readStatus(hash)
      if (status === null) continue
      mayHaveLanded = true
      const settled = status !== undefined ? settledBy(status, hash) : undefined
      if (settled !== undefined) return settled
    }

    const { blockhash } = decodeSolanaTransaction(signedTransaction)
    const validity = await rpc('isBlockhashValid', [blockhash, { commitment: 'confirmed' }]).catch(
      () => undefined
    )
    const valid = BlockhashValid.safeParse(validity?.result)
    if (valid.success && !valid.data.value) {
      // An expired blockhash only rules out the future, so this read comes after it, to
      // catch a transaction that landed before the blockhash ran out.
      const last = await readStatus(hash, { searchTransactionHistory: true })
      if (last === null && !mayHaveLanded) return { ok: false, error: EXPIRED }
      const settled = last !== null && last !== undefined ? settledBy(last, hash) : undefined
      if (settled !== undefined) return settled
    }
    return {
      ok: false,
      pending: true,
      error: `This was sent, but not confirmed yet. Check ${explorerUrl(hash)} before trying again, in case it goes through.`,
    }
  }
}
