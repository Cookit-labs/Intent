import type { VerifiedAsset } from '../swap/asset-registry'
import type { FollowOnAction } from '../parse-compound'
import type { OrchestrateTurn } from '../orchestrate/orchestrate'

/** The structured reading of an instruction, as the server validated it. */
export interface ActReading {
  action: 'swap' | 'supply' | 'borrow' | 'repay' | 'offramp'
  tokenIn: string
  tokenOut: string
  amountUsd: number
  amountStated: boolean
  amountIsUsd: boolean
  followOn: FollowOnAction | null
  style: 'market' | 'limit' | 'accumulate' | 'hedge' | 'rebalance' | 'route_liquidity'
  limitPriceUsd?: number
  liveAssets: VerifiedAsset[]
}

export type OrchestrateAnswer =
  | { outcome: 'act'; read: ActReading; instruction: string; context: string[] }
  | { outcome: 'ask'; question: string }
  | { outcome: 'help' }
  | { outcome: 'out_of_scope'; reason: string }
  | { outcome: 'unclear' }
  | { outcome: 'unavailable'; reason: string; tokens: string[] }

const UNREACHABLE: OrchestrateAnswer = { outcome: 'unavailable', reason: 'unreachable', tokens: [] }

const ACTIONS = ['swap', 'supply', 'borrow', 'repay', 'offramp'] as const
const STYLES = ['market', 'limit', 'accumulate', 'hedge', 'rebalance', 'route_liquidity'] as const

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * Asks the server what a typed message is.
 *
 * Never throws. A failed request or a reply that is not recognisable comes back
 * as `unavailable`, which the chat reports; nothing is run on a guess.
 */
export async function fetchOrchestrate(
  turns: OrchestrateTurn[],
  context: string[],
  chain: string,
  fetchImpl: typeof fetch = fetch
): Promise<OrchestrateAnswer> {
  try {
    const res = await fetchImpl('/api/intent/orchestrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turns, chain, ...(context.length > 0 ? { context } : {}) }),
    })
    if (!res.ok) return UNREACHABLE
    const a = (await res.json()) as Record<string, unknown>

    switch (a['outcome']) {
      case 'ask':
        return typeof a['question'] === 'string' && a['question'] !== ''
          ? { outcome: 'ask', question: a['question'] }
          : UNREACHABLE
      case 'help':
        return { outcome: 'help' }
      case 'out_of_scope':
        return {
          outcome: 'out_of_scope',
          reason: typeof a['reason'] === 'string' ? a['reason'] : '',
        }
      case 'unclear':
        return { outcome: 'unclear' }
      case 'unavailable':
        return {
          outcome: 'unavailable',
          reason: typeof a['reason'] === 'string' ? a['reason'] : 'unreadable',
          tokens: strings(a['tokens']),
        }
      case 'act': {
        const action = ACTIONS.find((k) => k === a['action'])
        const style = STYLES.find((k) => k === a['style']) ?? 'market'
        if (
          action === undefined ||
          typeof a['tokenIn'] !== 'string' ||
          typeof a['tokenOut'] !== 'string' ||
          typeof a['instruction'] !== 'string'
        ) {
          return UNREACHABLE
        }
        return {
          outcome: 'act',
          instruction: a['instruction'],
          context: strings(a['context']),
          read: {
            action,
            tokenIn: a['tokenIn'],
            tokenOut: a['tokenOut'],
            amountUsd: typeof a['amountUsd'] === 'number' ? a['amountUsd'] : 0,
            amountStated: a['amountStated'] === true,
            amountIsUsd: a['amountIsUsd'] === true,
            followOn: (a['followOn'] as FollowOnAction | null | undefined) ?? null,
            style,
            ...(typeof a['limitPriceUsd'] === 'number'
              ? { limitPriceUsd: a['limitPriceUsd'] }
              : {}),
            liveAssets: Array.isArray(a['liveAssets']) ? (a['liveAssets'] as VerifiedAsset[]) : [],
          },
        }
      }
      default:
        return UNREACHABLE
    }
  } catch {
    return UNREACHABLE
  }
}
