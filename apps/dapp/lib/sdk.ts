import type { CreateIntentInput, Intent, IntentStatus, IntentType } from '@intent/types'

/**
 * Minimal client surface the dapp consumes. Mirrors the intents section of
 * `@intent/sdk`'s IntentClient so components never branch on mock vs. real.
 * When the Go backend exists, a real implementation replaces `mockClient`
 * behind the same interface and the `NEXT_PUBLIC_USE_MOCK` flag.
 */
export interface IntentApi {
  create(input: CreateIntentInput): Promise<Intent>
  /**
   * Withdraw an intent that has not started executing.
   *
   * A limit order is a standing offer, so the ability to take it back is part
   * of the order type rather than a convenience.
   */
  cancel(id: string): Promise<Intent>
  /**
   * Record the transaction that settled an intent.
   *
   * Without this the swap's hash was produced, shown once, and dropped — the
   * intent and the transaction that fulfilled it were never connected, so
   * history could not offer a link to a trade that had genuinely happened.
   */
  settle(id: string, txHash: string): Promise<Intent>
  /**
   * Intents for one chain.
   *
   * Chain-scoped because an intent is a promise about a specific network: a
   * Stellar wallet cannot act on an Arc order, and listing both together
   * offered the user trades they had no way to settle.
   */
  list(chain?: string, prices?: Record<string, number>): Promise<Intent[]>
  get(id: string, prices?: Record<string, number>): Promise<Intent>
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

/** Limit intents wait for a price; market intents take what is offered. */
function isLimitType(type: IntentType): boolean {
  return type === 'limit_buy' || type === 'limit_sell' || type === 'accumulate'
}

/**
 * The status an intent should be reported as.
 *
 * Nothing here invents progress. Every intent used to climb to `settled`
 * fourteen seconds after creation on a timer, with no transaction behind it —
 * so history filled with rows that claimed to be completed trades and had no
 * hash, because nothing had ever been submitted to the network.
 *
 * An intent is settled when, and only when, a transaction hash has been
 * recorded against it.
 *
 * Only a limit order has an open state to be in: it is a standing offer, and
 * waiting is the whole point of it. A market order has no such state — it is
 * signed and settles, or it does not happen. One left unsigned was abandoned,
 * not pending, so it is reported as failed rather than sitting in the list
 * forever claiming to be live.
 */
function agedStatus(intent: Intent, marketPriceUsd?: number): IntentStatus {
  // A recorded hash is the only thing that settles an intent, and it is set
  // explicitly by `settle()` rather than inferred here.
  if (intent.status !== 'pending') return intent.status

  const expired = Date.now() > new Date(intent.deadline).getTime()

  if (isLimitType(intent.type) && intent.limitPriceUsd !== undefined) {
    // Expired without filling. Not settled — nothing was traded.
    if (expired) return 'cancelled'

    // Whether the price has been reached or not, the order is still open:
    // reaching the price is not the same as having executed, and nothing
    // signs or submits a transaction for a resting order yet.
    void marketPriceUsd
    return 'pending'
  }

  // A market order is signed within moments or not at all. Past its deadline
  // with no hash, the signature never came.
  return expired ? 'failed' : 'pending'
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

/**
 * Drops records that claim to have completed without a transaction behind
 * them.
 *
 * The old lifecycle marked every intent `settled` on a timer, so stored
 * history contains rows that read as finished trades and have no hash — they
 * were never submitted to any network. Keeping them would mean a history that
 * is mostly fiction, which is worse than a short one.
 *
 * Cancelled records are kept: they claim no trade, so they are still true.
 */
function keepOnlyReal(intents: Intent[]): Intent[] {
  return intents.filter((i) => {
    const hasHash = i.settlementTxHash !== undefined && i.settlementTxHash !== ''
    if (i.status === 'settled' || i.status === 'executing' || i.status === 'competition') {
      return hasHash
    }
    // A pending market order is an orphan: these used to be written the moment
    // Execute was clicked, so one the user never signed sat in the list
    // claiming to be live. Only a limit order genuinely rests unfilled.
    if (i.status === 'pending' && !isLimitType(i.type) && !hasHash) return false
    return true
  })
}

function load(): Intent[] {
  if (typeof window === 'undefined') return seed()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return seed()
    const stored = JSON.parse(raw) as Intent[]
    const real = keepOnlyReal(stored)
    // Rewrite once, so the fabricated rows do not come back on next load.
    if (real.length !== stored.length) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(real))
      } catch {
        /* see below */
      }
    }
    return real
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

function project(intent: Intent, prices?: Record<string, number>): Intent {
  return { ...intent, status: agedStatus(intent, prices?.[intent.tokenOut]) }
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
        ...(input.limitPriceUsd !== undefined ? { limitPriceUsd: input.limitPriceUsd } : {}),
        status: 'pending',
        createdAt: now(),
        updatedAt: now(),
      }
      store.unshift(created)
      persist(store)
      return created
    },
    async list(chain, prices) {
      await delay(300)
      const all = store.map((i) => project(i, prices))
      if (chain === undefined) return all
      // Intents recorded before chains were tracked have no slug. They are
      // kept rather than hidden — a settled trade disappearing from history
      // is worse than one appearing under both chains.
      return all.filter((i) => i.chain === undefined || i.chain === chain)
    },
    async get(intentId, prices) {
      await delay(200)
      const found = store.find((i) => i.id === intentId)
      if (!found) throw new Error(`Intent ${intentId} not found`)
      return project(found, prices)
    },
    async cancel(intentId) {
      await delay(300)
      const found = store.find((i) => i.id === intentId)
      if (!found) throw new Error(`Intent ${intentId} not found`)

      // Only an order that has not yet been acted on can be withdrawn. Once a
      // transaction is signed and submitted the chain owns the outcome, and
      // marking it cancelled here would claim otherwise.
      const live = project(found)
      if (live.status !== 'pending') {
        throw new Error('This intent is already being executed and can no longer be cancelled.')
      }

      found.status = 'cancelled'
      found.updatedAt = now()
      persist(store)
      return { ...found }
    },
    async settle(intentId, txHash) {
      const found = store.find((i) => i.id === intentId)
      if (!found) throw new Error(`Intent ${intentId} not found`)

      found.settlementTxHash = txHash
      // The chain has confirmed it, so the time-based projection no longer
      // applies — this is settled because a transaction says so.
      found.status = 'settled'
      found.updatedAt = now()
      persist(store)
      return { ...found }
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
