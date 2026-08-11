import type { CreateIntentInput, Intent, IntentStatus } from '@intent/types'

/**
 * Minimal client surface the dapp consumes. Mirrors the intents section of
 * `@intent/sdk`'s IntentClient so components never branch on mock vs. real.
 * When the Go backend exists, a real implementation replaces `mockClient`
 * behind the same interface and the `NEXT_PUBLIC_USE_MOCK` flag.
 */
export interface IntentApi {
  create(input: CreateIntentInput): Promise<Intent>
  list(): Promise<Intent[]>
  get(id: string): Promise<Intent>
}

export interface DappClient {
  intents: IntentApi
}

const now = () => new Date().toISOString()

let seq = 100
function id(): string {
  seq += 1
  return `intent_${seq}`
}

/**
 * Freshly-created mock intents advance through the lifecycle based on elapsed
 * time since creation. This previews Slice 2 (competition) and Slice 3
 * (settlement) without a backend, deterministically and without timers.
 */
function agedStatus(createdAtIso: string, base: IntentStatus): IntentStatus {
  if (base !== 'pending') return base
  const ageMs = Date.now() - new Date(createdAtIso).getTime()
  if (ageMs < 3_000) return 'pending'
  if (ageMs < 9_000) return 'competition'
  if (ageMs < 14_000) return 'executing'
  return 'settled'
}

function seed(): Intent[] {
  const base = {
    userId: 'user_local',
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    createdAt: now(),
    updatedAt: now(),
  }
  return [
    {
      ...base,
      id: 'intent_1',
      type: 'market_buy',
      tokenIn: 'USDC',
      tokenOut: 'WETH',
      amountIn: '5000',
      minAmountOut: '1.42',
      status: 'settled',
      escrowTxHash: '0xa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
      settlementTxHash: '0xb2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3',
    },
    {
      ...base,
      id: 'intent_2',
      type: 'accumulate',
      tokenIn: 'USDC',
      tokenOut: 'ARB',
      amountIn: '2500',
      minAmountOut: '1980',
      status: 'competition',
    },
    {
      ...base,
      id: 'intent_3',
      type: 'rebalance',
      tokenIn: 'USDT',
      tokenOut: 'USDC',
      amountIn: '10000',
      minAmountOut: '9985',
      status: 'executing',
    },
    {
      ...base,
      id: 'intent_4',
      type: 'limit_sell',
      tokenIn: 'WETH',
      tokenOut: 'USDC',
      amountIn: '3',
      minAmountOut: '10500',
      status: 'failed',
    },
  ]
}

const store: Intent[] = seed()

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function project(intent: Intent): Intent {
  return { ...intent, status: agedStatus(intent.createdAt, intent.status) }
}

const mockClient: DappClient = {
  intents: {
    async create(input) {
      await delay(600)
      const created: Intent = {
        id: id(),
        userId: 'user_local',
        type: input.type,
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        amountIn: input.amountIn,
        minAmountOut: input.minAmountOut,
        deadline: input.deadline,
        status: 'pending',
        createdAt: now(),
        updatedAt: now(),
      }
      store.unshift(created)
      return created
    },
    async list() {
      await delay(300)
      return store.map(project)
    },
    async get(intentId) {
      await delay(200)
      const found = store.find((i) => i.id === intentId)
      if (!found) throw new Error(`Intent ${intentId} not found`)
      return project(found)
    },
  },
}

const useMock = process.env['NEXT_PUBLIC_USE_MOCK'] !== 'false'

export function getIntentClient(): DappClient {
  // Real IntentClient wiring lands when the Go backend exists; until then the
  // mock is the default (backend is currently empty).
  if (!useMock) {
    throw new Error(
      'Live backend client not implemented yet. Set NEXT_PUBLIC_USE_MOCK=true (default) until the API is available.'
    )
  }
  return mockClient
}
