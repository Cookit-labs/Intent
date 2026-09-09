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

/**
 * No seeded intents.
 *
 * This used to return four fabricated intents with invented transaction
 * hashes. They rendered identically to real ones, so a user could not tell
 * which of their trades had actually happened — the history is only useful if
 * everything in it is true.
 */
function seed(): Intent[] {
  return []
}

/**
 * Where history lives until a backend does.
 *
 * Persisted to localStorage because the alternative — a module-level array —
 * loses every trade on reload, including ones that really settled on chain.
 * A history that forgets what happened is worse than no history, because it
 * looks authoritative.
 */
const STORAGE_KEY = 'intent.history.v1'

function load(): Intent[] {
  if (typeof window === 'undefined') return seed()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw === null ? seed() : (JSON.parse(raw) as Intent[])
  } catch {
    // Private-mode browsers throw on access; the session still works, it just
    // will not remember across reloads.
    return seed()
  }
}

function persist(intents: Intent[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(intents))
  } catch {
    /* see load() */
  }
}

const store: Intent[] = load()

/**
 * Records a swap that actually settled on chain.
 *
 * Called after submission rather than before, and only with a real hash: an
 * entry here is a claim that something happened, and the explorer link has to
 * lead somewhere real.
 */
export function recordSettledSwap(input: {
  type: Intent['type']
  tokenIn: string
  tokenOut: string
  amountIn: string
  amountOut: string
  txHash: string
}): Intent {
  const settled: Intent = {
    id: id(),
    userId: 'user_local',
    type: input.type,
    tokenIn: input.tokenIn,
    tokenOut: input.tokenOut,
    amountIn: input.amountIn,
    minAmountOut: input.amountOut,
    deadline: now(),
    status: 'settled',
    settlementTxHash: input.txHash,
    createdAt: now(),
    updatedAt: now(),
  }

  store.unshift(settled)
  persist(store)
  return settled
}

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
      persist(store)
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
