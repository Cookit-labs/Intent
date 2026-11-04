/**
 * What was said in the chat, kept until New chat.
 *
 * The mounted chat survives leaving the page; this survives a reload. It is a
 * transcript and nothing else: words and an explorer link, per chain and per
 * wallet, with nothing that could be signed or acted on.
 */

export interface LiveTurn {
  role: 'user' | 'agent'
  text: string
  explorerUrl?: string
  at: number
}

const STORAGE_BASE = 'intent.chat.live.v1'
const MAX_TURNS = 200

export function liveSessionKey(chain: string, account: string): string {
  return `${STORAGE_BASE}:${chain}:${account}`
}

/** The browser's storage, when it will hand it over. Private modes can refuse. */
export function liveSessionStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return new URL(value).protocol === 'https:' ? value : undefined
  } catch {
    return undefined
  }
}

/** Rebuilt field by field, so nothing else in an entry can come through. */
function toLiveTurn(value: unknown): LiveTurn | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { role, text, at, explorerUrl } = value as Record<string, unknown>
  if (role !== 'user' && role !== 'agent') return undefined
  if (typeof text !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) return undefined
  const link = httpsUrl(explorerUrl)
  return { role, text, at, ...(link !== undefined ? { explorerUrl: link } : {}) }
}

export function loadLiveSession(
  storage: Pick<Storage, 'getItem'> | undefined,
  chain: string,
  account: string
): LiveTurn[] {
  try {
    const raw = storage?.getItem(liveSessionKey(chain, account))
    if (raw === null || raw === undefined) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(toLiveTurn)
      .filter((turn): turn is LiveTurn => turn !== undefined)
      .slice(-MAX_TURNS)
  } catch {
    return []
  }
}

export function appendLiveTurn(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
  chain: string,
  account: string,
  turn: LiveTurn
): void {
  const clean = toLiveTurn(turn)
  if (clean === undefined) return
  try {
    const turns = [...loadLiveSession(storage, chain, account), clean].slice(-MAX_TURNS)
    storage?.setItem(liveSessionKey(chain, account), JSON.stringify(turns))
  } catch {
    // A full or refused store loses the transcript, never the chat.
  }
}

export function clearLiveSession(
  storage: Pick<Storage, 'removeItem'> | undefined,
  chain: string,
  account: string
): void {
  try {
    storage?.removeItem(liveSessionKey(chain, account))
  } catch {
    // Nothing to do: the chat on screen is cleared either way.
  }
}

/** Turns read for one wallet are shown to that wallet only, even for the render after a switch. */
export function ownedTurns(
  saved: { account: string; turns: LiveTurn[] } | null,
  account: string | undefined
): LiveTurn[] {
  return saved !== null && saved.account === account ? saved.turns : []
}

/**
 * Whether this address is the chat. `segment` is the path's first part, which on
 * Stellar carries the network, so a chain's bare slug would miss `/stellar-testnet`.
 */
export function showChatOnPath(pathname: string, segment: string): boolean {
  return pathname === `/${segment}/intents` || pathname === `/${segment}/intents/new`
}

/** The one line a chain race leaves in the transcript, once it has an ending. */
export function chainOutcomeSentence(outcome: {
  phase: string
  venueName?: string | undefined
  error?: string | undefined
}): string | undefined {
  const { phase, venueName, error } = outcome
  if (venueName === undefined) return phase === 'failed' ? error : undefined
  if (phase === 'settled') return `Sent on ${venueName}.`
  if (phase === 'pending') {
    return `The transaction on ${venueName} may have gone through, so check your wallet's activity before trying again.`
  }
  if (phase === 'failed') return `On ${venueName}: ${error ?? 'This could not be finished.'}`
  return undefined
}
