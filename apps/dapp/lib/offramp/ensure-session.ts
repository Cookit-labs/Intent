import type { AnchorEntry, AnchorId } from './anchors'
import { lookupAnchor } from './anchors'
import type { ChallengeSigner } from './sep10'
import { authenticate } from './sep10'
import type { WithdrawLimits } from './sep24'
import type { StoredSession } from './session-store'
import { loadSession, saveSession } from './session-store'
import type { AnchorToml } from './toml'

/**
 * A live SEP-10 session with one anchor, reusing one from this tab when it
 * is still valid and asking the wallet otherwise.
 *
 * Shared by the withdrawal flow and by the status refresh under Open
 * positions, so both authenticate the same way and neither prompts the
 * wallet when a token is already good.
 */
export interface EnsuredSession {
  entry: AnchorEntry
  toml: AnchorToml
  session: StoredSession
  limits?: WithdrawLimits
}

export async function ensureAuthSession(options: {
  anchorId: AnchorId
  account: string
  sign: ChallengeSigner
}): Promise<EnsuredSession> {
  const entry = lookupAnchor(options.anchorId)
  if (entry === undefined) throw new Error(`${options.anchorId} is not an anchor this app uses`)

  const res = await fetch(`/api/offramp/anchor?id=${options.anchorId}`)
  if (!res.ok) {
    let message = `The anchor lookup failed (HTTP ${res.status}).`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error !== undefined) message = body.error
    } catch {
      // The status is the message.
    }
    throw new Error(message)
  }
  const info = (await res.json()) as {
    toml?: AnchorToml
    limits?: WithdrawLimits | null
    error?: string
  }
  if (info.toml === undefined) throw new Error(info.error ?? 'The anchor could not be reached.')

  let session = loadSession(window.sessionStorage, options.anchorId, options.account)
  if (session === undefined) {
    const auth = await authenticate({
      anchor: entry,
      toml: info.toml,
      account: options.account,
      sign: options.sign,
    })
    session = { token: auth.token, expiresAt: auth.expiresAt }
    saveSession(window.sessionStorage, options.anchorId, options.account, session)
  }

  return {
    entry,
    toml: info.toml,
    session,
    ...(info.limits !== null && info.limits !== undefined ? { limits: info.limits } : {}),
  }
}
