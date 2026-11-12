import { SEND_VENUE_NAME } from '../chains/recipient'
import { accountMismatch } from '../weave/cashout-view'
import { toTurnCard, type TurnCard } from './turn-card'

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
  /** The last screen of the card this line closed, shown in its place. */
  card?: TurnCard
}

const STORAGE_BASE = 'intent.chat.live.v1'
const MAX_TURNS = 200
const MAX_TEXT = 2000

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

/**
 * A bank account number typed into a cash-out line must not sit in storage, and
 * one long paste must not use up the quota and silently stop later turns.
 */
function storedText(text: string): string {
  return text.replace(/\d{8,}/g, (run) => `••••${run.slice(-4)}`).slice(0, MAX_TEXT)
}

/** Rebuilt field by field, so nothing else in an entry can come through. */
function toLiveTurn(value: unknown): LiveTurn | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { role, text, at, explorerUrl, card } = value as Record<string, unknown>
  if (role !== 'user' && role !== 'agent') return undefined
  if (typeof text !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) return undefined
  const link = httpsUrl(explorerUrl)
  const kept = role === 'agent' && card !== undefined ? toTurnCard(card) : undefined
  return {
    role,
    text: storedText(text),
    at,
    ...(link !== undefined ? { explorerUrl: link } : {}),
    ...(kept !== undefined ? { card: kept } : {}),
  }
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

/**
 * What a change of wallet does to the chat on screen. Another wallet must never
 * see this one's chat, and resetting under an open signature would orphan it, so
 * that waits. A wallet arriving or going away is the gate's business, not a switch.
 */
export function ownerChange(
  previous: string | undefined,
  next: string | undefined,
  busy: boolean
): 'keep' | 'reset' | 'defer' {
  if (previous === undefined || next === undefined) return 'keep'
  if (accountMismatch(next, previous) === undefined) return 'keep'
  return busy ? 'defer' : 'reset'
}

export const WALLET_SWITCHED_NOTICE =
  'Your wallet changed. The payment under way here has to finish first.'
export const FINISH_SIGNATURE_NOTICE =
  'Finish or cancel the signature first, then continue the chat.'

/** Notices about a payment answer nothing the person said, so a reload would show them alone. */
export function recordableReply(text: string): boolean {
  return text !== WALLET_SWITCHED_NOTICE && text !== FINISH_SIGNATURE_NOTICE
}

const CARD_WITHOUT_DEADLINE_MS = 5 * 60_000

/** Whether a card still open when the person comes back has outlived what it was built on. */
export function cardIsStale(card: { deadline?: string; shownAt: number }, now: number): boolean {
  const deadline = card.deadline === undefined ? Number.NaN : Date.parse(card.deadline)
  return Number.isNaN(deadline) ? now - card.shownAt > CARD_WITHOUT_DEADLINE_MS : now >= deadline
}

/**
 * The label of the bank list's search box, in `bank-picker.tsx`. That file is not
 * ours to change, so a test reads it to keep the two in step.
 */
export const BANK_SEARCH_LABEL = 'Search banks'

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
  if (venueName === SEND_VENUE_NAME) {
    if (phase === 'settled') return 'Sent from your wallet.'
    if (phase === 'pending') {
      return "This transfer may have gone through, so check your wallet's activity before trying again."
    }
    return phase === 'failed' ? (error ?? 'This could not be finished.') : undefined
  }
  if (phase === 'settled') return `Sent on ${venueName}.`
  if (phase === 'pending') {
    return `The transaction on ${venueName} may have gone through, so check your wallet's activity before trying again.`
  }
  if (phase === 'failed') return `On ${venueName}: ${error ?? 'This could not be finished.'}`
  return undefined
}
