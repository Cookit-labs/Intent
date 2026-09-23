import { DEFINDEX_API_URL, DEFINDEX_NETWORK, defindexApiKey, type Env } from './config'

export { DEFINDEX_API_URL }

/**
 * The three calls this app makes to DeFindex's API.
 *
 * `fetch` directly rather than `@defindex/sdk`: three requests do not justify
 * an axios dependency, and an injectable `fetch` is what makes every path
 * here testable without a key. Shapes are taken from the API's own OpenAPI
 * document (`/api-json`, read 2026-09-23) and the SDK's published types
 * (`@defindex/sdk` 0.3.0), because no key was available to exercise them
 * live — which is also why every response is read defensively and anything
 * unexpected is a named refusal rather than a guess.
 *
 * Why the API at all, when the vault is a public contract this app could
 * call directly: the deposit needs simulation and auth assembly either way,
 * and DeFindex's relay (`/send`) sponsors the fee through a fee bump. The
 * envelope it hands back is treated exactly as any other third-party input
 * — re-read field by field before the wallet sees it, in `deposit.ts`.
 */

export interface DefindexApiOptions {
  /** Overrides the environment. Tests pass one; production reads `DEFINDEX_API_KEY`. */
  apiKey?: string
  env?: Env
  baseUrl?: string
  fetchImpl?: typeof fetch
}

function keyFor(options: DefindexApiOptions): string {
  const key = options.apiKey ?? defindexApiKey(options.env)
  if (key === undefined) throw new Error('DeFindex is not configured: DEFINDEX_API_KEY is unset')
  return key
}

/** The API's own message for a refusal, when it gave one. NestJS sends one string or a list. */
function messageOf(body: unknown): string | undefined {
  const message = (body as { message?: unknown } | null)?.message
  if (typeof message === 'string' && message !== '') return message
  if (Array.isArray(message)) return message.map(String).join('; ')
  return undefined
}

interface ApiReply {
  status: number
  ok: boolean
  body: unknown
}

async function call(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  options: DefindexApiOptions
): Promise<ApiReply> {
  const key = keyFor(options)
  const base = options.baseUrl ?? DEFINDEX_API_URL
  const doFetch = options.fetchImpl ?? fetch
  const joiner = path.includes('?') ? '&' : '?'

  const res = await doFetch(`${base}${path}${joiner}network=${DEFINDEX_NETWORK}`, {
    method: init.method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${key}`,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })

  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }
  return { status: res.status, ok: res.ok, body }
}

function refused(what: string, reply: ApiReply): Error {
  const detail = messageOf(reply.body)
  return new Error(`DeFindex ${what} ${reply.status}${detail !== undefined ? `: ${detail}` : ''}`)
}

export interface DefindexVaultInfo {
  /** 7-day trailing yield, annualised, as a percentage, net of vault fees. Absent when the API has none. */
  apy?: number
  /** The assets the vault holds, as contract ids. */
  assets: { address: string; symbol?: string }[]
  name?: string
  symbol?: string
}

/**
 * What a vault is and what it pays.
 *
 * One call rather than two: `GET /vault/{address}` carries the same 7-day
 * `apy` that `GET /vault/{address}/apy` does, and also names the assets the
 * vault holds — which the market context needs, because a vault holding a
 * different USDC from the one a swap delivers is not a venue for that swap.
 */
export async function readVault(
  vault: string,
  options: DefindexApiOptions = {}
): Promise<DefindexVaultInfo> {
  const reply = await call(`/vault/${vault}`, { method: 'GET' }, options)
  if (!reply.ok) throw refused('vault read', reply)

  const body = reply.body as {
    apy?: unknown
    assets?: unknown
    name?: unknown
    symbol?: unknown
  } | null

  const assets = Array.isArray(body?.assets)
    ? (body.assets as { address?: unknown; symbol?: unknown }[])
        .filter((a) => typeof a?.address === 'string')
        .map((a) => ({
          address: a.address as string,
          ...(typeof a.symbol === 'string' ? { symbol: a.symbol } : {}),
        }))
    : []

  return {
    // Absent rather than zero when the figure is missing or not a number.
    // The SDK's README warns it "may be undefined for new vaults", and an
    // absent rate is "not known", which the market context already treats
    // as "do not offer".
    ...(typeof body?.apy === 'number' && Number.isFinite(body.apy) ? { apy: body.apy } : {}),
    assets,
    ...(typeof body?.name === 'string' ? { name: body.name } : {}),
    ...(typeof body?.symbol === 'string' ? { symbol: body.symbol } : {}),
  }
}

export interface DepositRequest {
  vault: string
  /** The depositor. The API builds the envelope with this account as source and `from`. */
  account: string
  /** Base units, as a string. Converted to a JSON number only after it is known to survive that. */
  amount: string
}

/**
 * Asks the API to build an unsigned deposit, and returns the envelope.
 *
 * Returned untouched and unchecked: `buildDefindexDeposit` is what re-reads
 * it. This function's own refusals are about the request, not the reply.
 */
export async function requestDeposit(
  request: DepositRequest,
  options: DefindexApiOptions = {}
): Promise<string> {
  const amount = BigInt(request.amount)
  if (amount <= BigInt(0)) throw new Error('a deposit needs a positive amount')
  // The API takes amounts as JSON numbers. Above 2^53 a stroop count is
  // rounded in transit, and a deposit of "about" the balance is not the
  // deposit that was planned.
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`amount ${request.amount} cannot be carried exactly as a JSON number`)
  }

  const reply = await call(
    `/vault/${request.vault}/deposit`,
    {
      method: 'POST',
      body: {
        // One amount per asset the vault holds. The vaults this app uses
        // hold one, and the assertion refuses an envelope naming more.
        amounts: [Number(amount)],
        caller: request.account,
        // Hand the deposit to the strategy at once rather than leaving it
        // idle in the vault: idle funds earn nothing.
        invest: true,
        // A single-asset vault takes exactly what is offered, so a lower
        // minimum buys nothing and a floor equal to the amount is the
        // strictest honest one.
        slippageBps: 0,
      },
    },
    options
  )
  if (!reply.ok) throw refused('deposit build', reply)

  const xdr = (reply.body as { xdr?: unknown } | null)?.xdr
  // The SDK types this `string | null`. Null is the API declining to build.
  if (typeof xdr !== 'string' || xdr === '') {
    throw new Error('DeFindex returned no transaction to sign')
  }
  return xdr
}

export type DefindexSendResult =
  | { ok: true; hash: string; ledger?: number; shares?: string }
  | { ok: false; reason: 'rejected' | 'network_error'; detail?: string; hash?: string }

/**
 * Submits a signed deposit through DeFindex's relay.
 *
 * The relay rather than Horizon because it fee-bumps the transaction, so the
 * depositor pays no fee — the one thing a direct submission could not offer.
 * The result is mapped onto the shape every other submit in this app
 * returns, so the sequence hook needs no second vocabulary for failure.
 */
export async function sendSigned(
  signedXdr: string,
  options: DefindexApiOptions = {}
): Promise<DefindexSendResult> {
  let reply: ApiReply
  try {
    reply = await call('/send', { method: 'POST', body: { xdr: signedXdr } }, options)
  } catch (e) {
    return {
      ok: false,
      reason: 'network_error',
      detail: e instanceof Error ? e.message : 'the relay did not answer',
    }
  }

  if (!reply.ok) {
    const detail = messageOf(reply.body) ?? `DeFindex relay ${reply.status}`
    return { ok: false, reason: reply.status >= 500 ? 'network_error' : 'rejected', detail }
  }

  const body = reply.body as {
    txHash?: unknown
    success?: unknown
    ledger?: unknown
    result?: { type?: unknown; sharesMinted?: unknown } | null
  } | null
  const hash = typeof body?.txHash === 'string' ? body.txHash : undefined

  if (body?.success !== true) {
    return {
      ok: false,
      reason: 'rejected',
      detail: 'the transaction reached the network and failed there',
      ...(hash !== undefined ? { hash } : {}),
    }
  }
  if (hash === undefined) {
    return { ok: false, reason: 'rejected', detail: 'the relay reported success without a hash' }
  }

  const shares =
    body.result?.type === 'vault_deposit' && body.result.sharesMinted !== undefined
      ? String(body.result.sharesMinted)
      : undefined

  return {
    ok: true,
    hash,
    ...(typeof body.ledger === 'number' ? { ledger: body.ledger } : {}),
    ...(shares !== undefined ? { shares } : {}),
  }
}
