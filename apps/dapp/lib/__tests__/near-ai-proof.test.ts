import { createHash } from 'node:crypto'

import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it, vi } from 'vitest'

import {
  checkEnclave,
  checkReply,
  type EnclaveCheck,
  type ProofDeps,
} from '../agents/brains/nearai-proof'
import { createBrain } from '../agents/brains/openai-compatible'
import { ASK_TOOL } from '../agents/talk-prompts'

const MODEL = 'z-ai/glm-5.3-flash'
const NONCE = 'ab'.repeat(32)
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const SIGNER = account.address.toLowerCase()

const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'))
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

/** What the quote carries when the enclave holds the signer and answered this nonce. */
const boundReportData = (signer = SIGNER, nonce = NONCE): Uint8Array =>
  hex(`${signer.slice(2)}${'0'.repeat(24)}${nonce}`)

const jwt = (claims: Record<string, unknown>): string =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`

function report(overrides: Record<string, unknown> = {}): unknown {
  return {
    model_attestations: [
      {
        model_name: MODEL,
        signing_address: SIGNER,
        signing_algo: 'ecdsa',
        request_nonce: NONCE,
        intel_quote: '04000200',
        nvidia_payload: JSON.stringify({ nonce: NONCE, evidence_list: [] }),
        ...overrides,
      },
    ],
  }
}

function deps(over: {
  report?: unknown
  reportStatus?: number
  nras?: unknown
  quote?: Partial<{ status: string; tdAttributes: Uint8Array; reportData: Uint8Array }>
  quoteThrows?: boolean
  signature?: unknown
}): ProofDeps & { calls: string[] } {
  const calls: string[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/attestation/report')) {
      return new Response(JSON.stringify(over.report ?? report()), {
        status: over.reportStatus ?? 200,
      })
    }
    if (url.includes('nras.attestation.nvidia.com')) {
      return new Response(
        JSON.stringify(
          over.nras ?? [['JWT', jwt({ 'x-nvidia-overall-att-result': true, eat_nonce: NONCE })]]
        )
      )
    }
    if (url.includes('/signature/')) {
      return new Response(JSON.stringify(over.signature ?? {}))
    }
    return new Response('', { status: 404 })
  }) as unknown as typeof fetch
  return {
    calls,
    fetch: fetchImpl,
    nonce: () => NONCE,
    now: () => 1_000_000,
    verifyQuote: async () => {
      if (over.quoteThrows === true) throw new Error('bad quote')
      return {
        status: 'UpToDate',
        tdAttributes: hex('0000001000000000'),
        reportData: boundReportData(),
        ...over.quote,
      }
    },
  }
}

describe('checkEnclave', () => {
  it('passes a genuine, up to date, non-debug enclave that holds the signer for this nonce', async () => {
    const d = deps({})
    expect(await checkEnclave(MODEL, d)).toEqual({
      ok: true,
      value: { model: MODEL, signer: SIGNER, checkedAt: 1_000_000 },
    })
    expect(d.calls[0]).toContain(`nonce=${NONCE}`)
    expect(d.calls[0]).toContain('signing_algo=ecdsa')
  })

  it.each([
    ['the report is unavailable', { reportStatus: 503 }, 'report_unavailable'],
    ['the model is missing', { report: { model_attestations: [] } }, 'report_unavailable'],
    [
      'the nonce is not echoed',
      { report: report({ request_nonce: 'cd'.repeat(32) }) },
      'nonce_mismatch',
    ],
    ['the quote does not verify', { quoteThrows: true }, 'quote_invalid'],
    ['the TCB is out of date', { quote: { status: 'OutOfDate' } }, 'tcb_not_up_to_date'],
    [
      'the enclave runs in debug mode',
      { quote: { tdAttributes: hex('0100001000000000') } },
      'debug_enclave',
    ],
    [
      'the quote binds another signer',
      { quote: { reportData: boundReportData(`0x${'22'.repeat(20)}`) } },
      'signer_not_bound',
    ],
    [
      'the quote answers another nonce',
      { quote: { reportData: boundReportData(SIGNER, 'cd'.repeat(32)) } },
      'signer_not_bound',
    ],
    [
      'NVIDIA does not pass the GPU',
      { nras: [['JWT', jwt({ 'x-nvidia-overall-att-result': false, eat_nonce: NONCE })]] },
      'gpu_unverified',
    ],
    [
      'NVIDIA answers another nonce',
      { nras: [['JWT', jwt({ 'x-nvidia-overall-att-result': true, eat_nonce: 'cd'.repeat(32) })]] },
      'gpu_unverified',
    ],
  ])('fails closed when %s', async (_name, over, reason) => {
    expect(await checkEnclave(MODEL, deps(over))).toEqual({ ok: false, reason })
  })
})

describe('a NEAR AI brain reply', () => {
  const toolReply = {
    id: 'chat_9',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: { tool_calls: [{ function: { arguments: '{"to":"Jeff","question":"Why?"}' } }] },
      },
    ],
  }
  const responseBody = JSON.stringify(toolReply)
  const talk = { agent: 'a', system: 'sys', user: 'usr', tool: ASK_TOOL }

  function brainDeps(): ProofDeps & { sent: string[] } {
    const sent: string[] = []
    const base = deps({})
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/signature/chat_9')) {
        const text = `${MODEL}:${sha(sent[0] ?? '')}:${sha(responseBody)}`
        return new Response(
          JSON.stringify({
            text,
            signature: await account.signMessage({ message: text }),
            signing_address: SIGNER,
            signature_kind: 'provider_tee',
          })
        )
      }
      if (url.endsWith('/chat/completions')) {
        sent.push(String(init?.body))
        return new Response(responseBody)
      }
      return base.fetch(input, init)
    }) as unknown as typeof fetch
    return { ...base, fetch: fetchImpl, sent }
  }

  it('checks the exact bytes sent and received against the attested key', async () => {
    const d = brainDeps()
    const brain = createBrain({
      provider: 'nearai',
      apiKey: 'k',
      model: MODEL,
      baseUrl: 'https://near.test/v1',
      fetchImpl: d.fetch,
      proofDeps: d,
    })
    const out = await brain.talk?.(talk)
    expect(out?.ok).toBe(true)
    const proof = out?.ok === true ? await out.proof?.() : undefined
    expect(proof).toMatchObject({
      verified: true,
      signer: SIGNER,
      requestHash: sha(d.sent[0] ?? ''),
      responseHash: sha(responseBody),
    })
  })

  it('offers no proof from a provider that does not sign its replies', async () => {
    const d = brainDeps()
    const out = await createBrain({
      provider: 'groq',
      apiKey: 'k',
      model: 'x',
      baseUrl: 'https://groq.test/v1',
      fetchImpl: d.fetch,
      proofDeps: d,
    }).talk?.(talk)
    expect(out?.ok === true && out.proof).toBeFalsy()
  })
})

describe('checkReply', () => {
  const enclave: EnclaveCheck = { model: MODEL, signer: SIGNER, checkedAt: 1_000_000 }
  const requestBody = JSON.stringify({ model: MODEL, messages: [] })
  const responseBody = JSON.stringify({ id: 'chat_1', choices: [] })
  const text = `${MODEL}:${sha(requestBody)}:${sha(responseBody)}`

  async function signed(over: Record<string, unknown> = {}): Promise<unknown> {
    return {
      text,
      signature: await account.signMessage({ message: text }),
      signing_address: SIGNER,
      signing_algo: 'ecdsa',
      signature_kind: 'provider_tee',
      ...over,
    }
  }

  const call = async (signature: unknown, body = responseBody) => {
    const d = deps({ signature })
    const proof = await checkReply(
      {
        baseUrl: 'https://cloud-api.near.ai/v1',
        apiKey: 'k',
        chatId: 'chat_1',
        requestBody,
        responseBody: body,
        enclave,
      },
      d
    )
    return { proof, calls: d.calls }
  }

  it('verifies a reply signed by the attested key over these exact bytes', async () => {
    const { proof, calls } = await call(await signed())
    expect(proof).toEqual({
      verified: true,
      model: MODEL,
      signer: SIGNER,
      requestHash: sha(requestBody),
      responseHash: sha(responseBody),
      checkedAt: 1_000_000,
    })
    expect(calls[0]).toBe(
      `https://cloud-api.near.ai/v1/signature/chat_1?model=${encodeURIComponent(MODEL)}&signing_algo=ecdsa`
    )
  })

  it('refuses a reply whose bytes differ from what was signed', async () => {
    expect((await call(await signed(), `${responseBody} `)).proof).toEqual({
      verified: false,
      reason: 'hash_mismatch',
    })
  })

  it('refuses a signature from a key the enclave did not attest', async () => {
    const other = privateKeyToAccount(`0x${'33'.repeat(32)}`)
    const sig = await signed({ signature: await other.signMessage({ message: text }) })
    expect((await call(sig)).proof).toEqual({ verified: false, reason: 'signer_mismatch' })
  })

  it('refuses a claimed signer that is not the attested one, even if it recovers', async () => {
    const other = privateKeyToAccount(`0x${'33'.repeat(32)}`)
    const sig = await signed({
      signature: await other.signMessage({ message: text }),
      signing_address: other.address,
    })
    expect((await call(sig)).proof).toEqual({ verified: false, reason: 'signer_mismatch' })
  })

  it('refuses a gateway signature, which does not prove the model produced it', async () => {
    expect((await call(await signed({ signature_kind: 'gateway' }))).proof).toEqual({
      verified: false,
      reason: 'not_provider_tee',
    })
  })

  it('reports a missing signature as unverified', async () => {
    expect((await call({ error: { message: 'not found' } })).proof).toEqual({
      verified: false,
      reason: 'signature_unavailable',
    })
  })
})
