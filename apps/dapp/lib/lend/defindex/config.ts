/**
 * Whether DeFindex is reachable from this deployment.
 *
 * The same gate the model providers use: a venue is "configured" when the
 * secret it needs is present, and an unconfigured venue is absent from
 * everything — the agents' menu, the parser's allowlist, the Apps page's
 * claims — rather than present and failing at signing time. DeFindex builds
 * its deposit through a keyed API (every vault route answers 403 without one,
 * measured 2026-09-23), so without `DEFINDEX_API_KEY` there is nothing this
 * app can do there.
 *
 * One key serves both networks. This app only ever asks for testnet.
 */

export const DEFINDEX_API_URL = 'https://api.defindex.io'

/** Every call carries this. There is no mainnet path in this app. */
export const DEFINDEX_NETWORK = 'testnet'

export const DEFINDEX_API_KEY_ENV = 'DEFINDEX_API_KEY'

/**
 * What `process.env` looks like to the code that reads a key from it.
 *
 * A plain record rather than `NodeJS.ProcessEnv`, whose augmentation here
 * requires `NODE_ENV` — a test handing in `{ DEFINDEX_API_KEY: 'sk' }` is
 * saying everything it means to say.
 */
export type Env = Record<string, string | undefined>

/** The key, or nothing. A blank value is nothing: `DEFINDEX_API_KEY=` is the common state of an `.env`. */
export function defindexApiKey(env: Env = process.env): string | undefined {
  const key = env[DEFINDEX_API_KEY_ENV]?.trim()
  return key === undefined || key === '' ? undefined : key
}

export function isDefindexConfigured(env: Env = process.env): boolean {
  return defindexApiKey(env) !== undefined
}
