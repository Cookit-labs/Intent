/**
 * Talking to the Go backend.
 *
 * Thin on purpose. `packages/sdk` already gestures at this across sixty lines
 * of `TODO: implement`, with untyped returns and paths that do not match the
 * routes the server actually serves — useful as a shape, not as an
 * implementation.
 *
 * Two things this does that raw `fetch` at each call site would not: it carries
 * the session token without every caller remembering to, and it turns the
 * server's error envelope into a typed failure rather than an `HTTP 400` with
 * the reason discarded. The backend replies `{ error, status }` on every
 * failure path, and that message is written for a person to read.
 */

export class ApiError extends Error {
  readonly status: number
  /** True when the session is missing, expired, or rejected. */
  readonly unauthorized: boolean

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.unauthorized = status === 401
  }
}

/** Where the backend lives. Inlined at build time, so a stale bundle can disagree. */
export function apiBaseUrl(): string {
  return process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:8080'
}

interface ErrorEnvelope {
  error?: string
  status?: number
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  /** Bearer token, when the route requires a session. */
  token?: string | undefined
  signal?: AbortSignal
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token, signal } = options

  let res: Response
  try {
    res = await fetch(`${apiBaseUrl()}/api/v1${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal !== undefined ? { signal } : {}),
    })
  } catch (e) {
    // A network failure and a rejected request are different problems and the
    // UI says different things about them, so they must not collapse into one
    // message. Status 0 means the request never reached the server.
    throw new ApiError(
      e instanceof Error && e.name === 'AbortError'
        ? 'The request was cancelled.'
        : 'Could not reach the server.',
      0
    )
  }

  if (res.status === 204) return undefined as T

  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    if (res.ok) return undefined as T
    throw new ApiError(`The server returned an unreadable response (${res.status}).`, res.status)
  }

  if (!res.ok) {
    const envelope = payload as ErrorEnvelope
    throw new ApiError(envelope.error ?? `Request failed (${res.status}).`, res.status)
  }

  return payload as T
}
