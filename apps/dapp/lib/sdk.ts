import type { CreateIntentInput, Intent, IntentStatus } from '@intent/types'

/**
 * Minimal client surface the dapp consumes. Mirrors the intents section of
 * `@intent/sdk`'s IntentClient so components never branch on mock vs. real.
 * When the Go backend exists, a real implementation replaces `mockClient`
 * behind the same interface and the `NEXT_PUBLIC_USE_MOCK` flag.
 */
export interface IntentApi {
  create(input: CreateIntentInput): Promise<Intent>
  /**
   * Intents for one chain.
   *
   * Chain-scoped because an intent is a promise about a specific network: a
   * Stellar wallet cannot act on an Arc order, and listing both together
   * offered the user trades they had no way to settle.
   */
  list(chain?: string): Promise<Intent[]>
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
        ...(input.chain !== undefined ? { chain: input.chain } : {}),
        status: 'pending',
        createdAt: now(),
        updatedAt: now(),
      }
      store.unshift(created)
      persist(store)
      return created
    },
    async list(chain) {
      await delay(300)
      const all = store.map(project)
      if (chain === undefined) return all
      // Intents recorded before chains were tracked have no slug. They are
      // kept rather than hidden — a settled trade disappearing from history
      // is worse than one appearing under both chains.
      return all.filter((i) => i.chain === undefined || i.chain === chain)
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
