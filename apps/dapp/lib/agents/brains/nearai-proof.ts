import { createHash, randomBytes } from 'node:crypto'

import { getCollateralFromPcs, verify } from '@phala/dcap-qvl'
import { recoverMessageAddress } from 'viem'

/**
 * Proof that a NEAR AI reply came from an attested enclave, checked on the server.
 *
 * Two halves, following docs.near.ai/cloud/verification:
 * - The enclave: a report fetched with a fresh nonce. Its Intel TDX quote must verify against
 *   Intel's own collateral, be up to date, not run in debug mode, and bind the model's signing
 *   address and this nonce. NVIDIA's attestation service must pass the GPUs for the same nonce.
 * - The reply: NEAR AI's signature over the hashes of the exact request and response bytes must
 *   recover to that attested address, and be the model's own (`provider_tee`), not the gateway's.
 *
 * It proves the hardware, the debug flag, freshness and the key. It does not pin which software
 * image ran, and instances of a model share one key, so a match does not name one machine.
 */

export const NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu'

/** How long a passed enclave check is reused before a fresh nonce is asked for. */
export const ENCLAVE_TTL_MS = 5 * 60_000

export type EnclaveFailure =
  | 'report_unavailable'
  | 'nonce_mismatch'
  | 'quote_invalid'
  | 'tcb_not_up_to_date'
  | 'debug_enclave'
  | 'signer_not_bound'
  | 'gpu_unverified'

export type ReplyFailure =
  | EnclaveFailure
  | 'signature_unavailable'
  | 'not_provider_tee'
  | 'hash_mismatch'
  | 'signer_mismatch'

export interface EnclaveCheck {
  model: string
  /** The model's signing address, lower case, as bound inside the verified quote. */
  signer: string
  checkedAt: number
}

export type ReplyProof =
  | {
      verified: true
      model: string
      signer: string
      requestHash: string
      responseHash: string
      /** When the enclave behind the signer was last checked. */
      checkedAt: number
    }
  | { verified: false; reason: ReplyFailure }

interface VerifiedQuote {
  status: string
  tdAttributes: Uint8Array
  reportData: Uint8Array
}

export interface ProofDeps {
  fetch: typeof fetch
  verifyQuote: (quote: Uint8Array) => Promise<VerifiedQuote>
  nonce: () => string
  now: () => number
}

async function verifyWithIntel(quote: Uint8Array): Promise<VerifiedQuote> {
  const collateral = await getCollateralFromPcs(quote)
  const verified = verify(quote, collateral, Math.floor(Date.now() / 1000))
  const td = verified.report.asTd10() ?? verified.report.asTd15()?.base
  if (td === undefined || td === null) throw new Error('not a TDX quote')
  return { status: verified.status, tdAttributes: td.tdAttributes, reportData: td.reportData }
}

export const DEFAULT_PROOF_DEPS: ProofDeps = {
  fetch: (...args) => fetch(...args),
  verifyQuote: verifyWithIntel,
  nonce: () => randomBytes(32).toString('hex'),
  now: () => Date.now(),
}

const NEAR_AI_URL = 'https://cloud-api.near.ai/v1'

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

interface ModelAttestation {
  model_name?: string
  signing_address?: string
  request_nonce?: string
  intel_quote?: string
  nvidia_payload?: unknown
}

/** NVIDIA's overall verdict for the GPUs, read from the first token it returns over TLS. */
async function gpuPasses(payload: unknown, nonce: string, deps: ProofDeps): Promise<boolean> {
  try {
    const res = await deps.fetch(NRAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    })
    if (!res.ok) return false
    const tokens = (await res.json()) as unknown
    const first = Array.isArray(tokens) ? (tokens[0] as unknown) : undefined
    const token = Array.isArray(first) ? first[1] : undefined
    if (typeof token !== 'string') return false
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')
    ) as Record<string, unknown>
    return claims['x-nvidia-overall-att-result'] === true && claims['eat_nonce'] === nonce
  } catch {
    return false
  }
}

/** Checks the model's enclave with a fresh nonce. Anything unproven fails closed. */
export async function checkEnclave(
  model: string,
  deps: ProofDeps = DEFAULT_PROOF_DEPS,
  baseUrl = NEAR_AI_URL
): Promise<{ ok: true; value: EnclaveCheck } | { ok: false; reason: EnclaveFailure }> {
  const nonce = deps.nonce()
  let entry: ModelAttestation | undefined
  try {
    const res = await deps.fetch(
      `${baseUrl}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`
    )
    if (!res.ok) return { ok: false, reason: 'report_unavailable' }
    const body = (await res.json()) as { model_attestations?: ModelAttestation[] }
    entry = body.model_attestations?.find((a) => a.model_name === model)
  } catch {
    return { ok: false, reason: 'report_unavailable' }
  }
  const signer = entry?.signing_address?.toLowerCase()
  if (
    entry?.intel_quote === undefined ||
    signer === undefined ||
    !/^0x[0-9a-f]{40}$/.test(signer)
  ) {
    return { ok: false, reason: 'report_unavailable' }
  }
  if (entry.request_nonce !== nonce) return { ok: false, reason: 'nonce_mismatch' }

  let quote: VerifiedQuote
  try {
    quote = await deps.verifyQuote(Uint8Array.from(Buffer.from(entry.intel_quote, 'hex')))
  } catch {
    return { ok: false, reason: 'quote_invalid' }
  }
  if (quote.status !== 'UpToDate') return { ok: false, reason: 'tcb_not_up_to_date' }
  // TDX attribute bit 0 is DEBUG; a debug enclave can be read by its host.
  if (((quote.tdAttributes[0] ?? 1) & 1) !== 0) return { ok: false, reason: 'debug_enclave' }
  // Report data: the signing address zero-padded to 32 bytes, then the nonce.
  if (toHex(quote.reportData) !== `${signer.slice(2)}${'0'.repeat(24)}${nonce}`) {
    return { ok: false, reason: 'signer_not_bound' }
  }
  if (!(await gpuPasses(entry.nvidia_payload, nonce, deps))) {
    return { ok: false, reason: 'gpu_unverified' }
  }
  return { ok: true, value: { model, signer, checkedAt: deps.now() } }
}

type EnclaveResult = Awaited<ReturnType<typeof checkEnclave>>

const enclaves = new Map<string, { at: number; check: Promise<EnclaveResult> }>()

/**
 * The model's enclave check, shared for a few minutes so a race doesn't wait on Intel and NVIDIA
 * for every reply. A failed check is never kept.
 */
export function enclaveFor(
  model: string,
  baseUrl = NEAR_AI_URL,
  deps: ProofDeps = DEFAULT_PROOF_DEPS
): Promise<EnclaveResult> {
  const key = `${baseUrl} ${model}`
  const hit = enclaves.get(key)
  if (hit !== undefined && deps.now() - hit.at < ENCLAVE_TTL_MS) return hit.check
  const check = checkEnclave(model, deps, baseUrl)
  enclaves.set(key, { at: deps.now(), check })
  void check.then((r) => {
    if (!r.ok && enclaves.get(key)?.check === check) enclaves.delete(key)
  })
  return check
}

/** One reply's proof: the enclave behind it, then its signature. */
export async function proveReply(
  enclave: Promise<EnclaveResult>,
  reply: Omit<ReplyInput, 'enclave'>,
  deps: ProofDeps = DEFAULT_PROOF_DEPS
): Promise<ReplyProof> {
  const checked = await enclave
  if (!checked.ok) return { verified: false, reason: checked.reason }
  return checkReply({ ...reply, enclave: checked.value }, deps)
}

export interface ReplyInput {
  baseUrl: string
  apiKey: string
  chatId: string
  /** The request body exactly as sent. */
  requestBody: string
  /** The response body exactly as received. */
  responseBody: string
  enclave: EnclaveCheck
}

/** Checks NEAR AI's signature over one reply against an enclave already checked. */
export async function checkReply(
  input: ReplyInput,
  deps: ProofDeps = DEFAULT_PROOF_DEPS
): Promise<ReplyProof> {
  const { enclave } = input
  let sig: Record<string, unknown>
  try {
    const res = await deps.fetch(
      `${input.baseUrl}/signature/${encodeURIComponent(input.chatId)}?model=${encodeURIComponent(enclave.model)}&signing_algo=ecdsa`,
      { headers: { Authorization: `Bearer ${input.apiKey}` } }
    )
    sig = res.ok ? ((await res.json()) as Record<string, unknown>) : {}
  } catch {
    sig = {}
  }
  const { text, signature, signing_address: claimed, signature_kind: kind } = sig
  if (typeof text !== 'string' || typeof signature !== 'string' || typeof claimed !== 'string') {
    return { verified: false, reason: 'signature_unavailable' }
  }
  if (kind !== 'provider_tee') return { verified: false, reason: 'not_provider_tee' }

  const requestHash = sha256(input.requestBody)
  const responseHash = sha256(input.responseBody)
  if (text !== `${enclave.model}:${requestHash}:${responseHash}`) {
    return { verified: false, reason: 'hash_mismatch' }
  }

  let recovered: string
  try {
    recovered = (
      await recoverMessageAddress({ message: text, signature: signature as `0x${string}` })
    ).toLowerCase()
  } catch {
    return { verified: false, reason: 'signer_mismatch' }
  }
  if (recovered !== enclave.signer || claimed.toLowerCase() !== enclave.signer) {
    return { verified: false, reason: 'signer_mismatch' }
  }
  return {
    verified: true,
    model: enclave.model,
    signer: enclave.signer,
    requestHash,
    responseHash,
    checkedAt: enclave.checkedAt,
  }
}
