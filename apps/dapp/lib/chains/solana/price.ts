import { z } from 'zod'

import type { ChainToken } from '../types'
import { JUPITER_API, jupiterHeaders, venueFetch } from './http'
import { SOLANA_TOKENS } from './tokens'

const CACHE_MS = 20_000

const Entry = z.object({ usdPrice: z.number().finite().positive() })

export interface PriceSourceOptions {
  env?: Record<string, string | undefined>
  retryDelayMs?: number
}

/**
 * Live dollar prices from Jupiter's Price API, which omits a token it has no
 * reliable price for. A stablecoin gets what the source says, not an assumed $1,
 * and anything missing stays missing so the trade is refused.
 *
 * All tokens are read in one request and briefly kept, since a keyless caller may
 * make one request every two seconds and building an action takes several.
 */
export function createPriceSource(options: PriceSourceOptions = {}) {
  const env = options.env ?? process.env
  let cached: { at: number; table: Promise<Map<string, number>> } | undefined

  async function readTable(): Promise<Map<string, number>> {
    const ids = SOLANA_TOKENS.map((t) => t.id).join(',')
    const { status, body } = await venueFetch(`${JUPITER_API}/price/v3?ids=${ids}`, {
      label: 'Jupiter',
      headers: jupiterHeaders(env),
      ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
    })
    if (status !== 200 || typeof body !== 'object' || body === null) return new Map()
    const table = new Map<string, number>()
    for (const [mint, entry] of Object.entries(body)) {
      const parsed = Entry.safeParse(entry)
      if (parsed.success) table.set(mint, parsed.data.usdPrice)
    }
    return table
  }

  return async (token: ChainToken): Promise<number | undefined> => {
    if (cached === undefined || Date.now() - cached.at > CACHE_MS) {
      const table = readTable()
      cached = { at: Date.now(), table }
      // A failed read is not worth keeping: the next trade should ask again.
      void table.then(
        (read) => {
          if (read.size === 0) cached = undefined
        },
        () => {
          cached = undefined
        }
      )
    }
    try {
      return (await cached.table).get(token.id)
    } catch {
      return undefined
    }
  }
}
