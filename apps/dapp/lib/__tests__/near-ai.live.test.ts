import { describe, expect, it } from 'vitest'

import type { ProposalRequest } from '../agents/brain'
import { createBrain } from '../agents/brains/openai-compatible'
import { PROVIDERS } from '../agents/brains/providers'
import { ASK_TOOL } from '../agents/talk-prompts'
import { parseIntent } from '../parse-intent'

/**
 * The real NEAR AI Cloud gateway.
 *
 * The catalogue needs no key. It is what stops the default model drifting to one the gateway
 * only forwards to an outside lab, which would run outside secure hardware under the same name.
 * The calls below spend a fraction of a cent of credit, so they run only with a key.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const KEY = process.env['NEARAI_API_KEY']?.trim()
const CALL_TIMEOUT_MS = 90_000

interface CatalogueModel {
  modelId: string
  metadata?: {
    verifiable?: boolean
    attestationSupported?: boolean
    supportedFeatures?: string[] | null
  }
}

describe.skipIf(SKIP)('NEAR AI Cloud catalogue', () => {
  it('lists the default model as verifiable, attested and able to call tools', async () => {
    const response = await fetch('https://cloud-api.near.ai/v1/model/list')
    expect(response.status).toBe(200)
    const { models } = (await response.json()) as { models: CatalogueModel[] }
    const model = models.find((m) => m.modelId === PROVIDERS.nearai.defaultModel)

    expect(model?.metadata?.verifiable).toBe(true)
    expect(model?.metadata?.attestationSupported).toBe(true)
    expect(model?.metadata?.supportedFeatures).toContain('tools')
  })
})

describe.skipIf(SKIP || KEY === undefined || KEY === '')('NEAR AI Cloud agent', () => {
  const brain = createBrain({ provider: 'nearai', ...(KEY !== undefined ? { apiKey: KEY } : {}) })

  it(
    'answers a race with a proposal that passes validation',
    async () => {
      const request: ProposalRequest = {
        intent: parseIntent('Swap 20 USDC to XLM'),
        agent: 'nearai:live',
        seat: 0,
        chain: 'stellar',
        market: {
          asOf: new Date().toISOString(),
          prices: { XLM: 0.18, USDC: 1 },
          venues: [{ id: 'soroswap', name: 'Soroswap', category: 'dex' }],
          volatilityHint: 'normal',
          gasHint: 'cheap',
        },
      }

      const outcome = await brain.propose(request)
      // eslint-disable-next-line no-console
      console.log('propose', outcome.ok, outcome.meta)
      expect(outcome).toMatchObject({ ok: true })
    },
    CALL_TIMEOUT_MS
  )

  it(
    'answers a talk turn with a tool call',
    async () => {
      const outcome = await brain.talk?.({
        agent: 'nearai:live',
        system: 'You are racing other agents to route a swap. Question one of them.',
        user: 'Jeff picked Soroswap for 20 USDC to XLM. Ask Jeff one short question.',
        tool: ASK_TOOL,
      })
      // eslint-disable-next-line no-console
      console.log('talk', outcome?.ok, outcome?.meta)
      expect(outcome).toMatchObject({ ok: true })
    },
    CALL_TIMEOUT_MS
  )
})
