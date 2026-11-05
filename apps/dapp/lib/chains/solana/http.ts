import { ChainActionRefused } from '../types'

const DEFAULT_TIMEOUT_MS = 15_000
/** Jupiter allows one keyless request every two seconds. */
const DEFAULT_RETRY_DELAY_MS = 2_100

export interface VenueRequest {
  /** Named in what the user reads, such as "Jupiter". */
  label: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
  retryDelayMs?: number
}

export interface VenueResponse {
  status: number
  /** The parsed body, or undefined if it was not JSON. */
  body: unknown
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A venue API call made while building an action, when nothing has been signed.
 * Being unreachable or rate limited is a refusal the user can act on. Other
 * statuses go back to the caller, who knows what they mean for that venue.
 */
export async function venueFetch(url: string, request: VenueRequest): Promise<VenueResponse> {
  const { label, method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = request
  const send = async (): Promise<Response> => {
    try {
      return await fetch(url, {
        method,
        headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      throw new ChainActionRefused(
        `${label} didn't answer in time. Nothing was signed or sent, so try again in a moment.`
      )
    }
  }

  let response = await send()
  if (response.status === 429) {
    await wait(request.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
    response = await send()
  }
  if (response.status === 429) {
    throw new ChainActionRefused(
      `${label} is busy right now. Nothing was signed or sent, so try again in a few seconds.`
    )
  }
  const text = await response.text().catch(() => '')
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    return { status: response.status, body: undefined }
  }
}

export function jupiterHeaders(env: Record<string, string | undefined>): Record<string, string> {
  const key = env['JUPITER_API_KEY']?.trim()
  return key === undefined || key === '' ? {} : { 'x-api-key': key }
}

export const JUPITER_API = 'https://api.jup.ag'
