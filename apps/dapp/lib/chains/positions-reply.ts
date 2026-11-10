import type { BlendBalance, BlendPositions } from '../lend/position'
import { parseChainAction } from './parse-action'
import type { ChainActionKind, ChainActionRequest, VenuePosition } from './types'

/** Client-safe: the chat reads a question and words the answer from here, and the route only reads. */

export interface VenueHoldings {
  id: string
  name: string
  kinds: readonly ChainActionKind[]
  /** Read from the chain just now. Empty means nothing is there. */
  positions: VenuePosition[]
}

export interface PositionsReport {
  venues: VenueHoldings[]
  /** Venues that could not be read, so the money may be there. Never the same as empty. */
  unread: { id: string; name: string }[]
}

const TOKEN = String.raw`[a-z][a-z0-9.+]{0,11}`
const AT_VENUE = String.raw`(?: (?:on|in|at|from|with) [a-z0-9][a-z0-9 .-]{1,30})?`
const PLACED = 'deposited|supplied|lent|staked|borrowed'
const PUT = `${PLACED}|saved|deposit|supply|lend|stake|save|borrow`
const TAKE = 'withdraw|unstake|claim|redeem|collect|repay|take out'
const HOW_MUCH = String.raw`how much(?: of)?(?: my)?(?: ${TOKEN})?`
const HOLDINGS = String.raw`(?:(?:staking|lending|defi|savings?|earn|yield) )?positions?|deposits?|stakes?|loans?|debts?|borrows?|claims?`
const MONEY = 'money|funds?|cash|crypto|deposits?|savings|stake'

/**
 * Whole-message shapes, so a sentence that asks for something else never lands here. Words a
 * balance question uses, "balance", "tokens", "assets", "what do I have", are in none of them.
 */
const POSITION_QUESTIONS = [
  String.raw`(?:what(?:'s| is| are|s) )?(?:all )?my (?:open |current |active )?(?:${HOLDINGS})${AT_VENUE}`,
  String.raw`my (?:${PLACED})(?: ${TOKEN})?${AT_VENUE}`,
  String.raw`(?:open |current |active )?positions${AT_VENUE}`,
  String.raw`(?:what|${HOW_MUCH}) (?:have i got|have i|i have|i've|ive|do i have|did i) (?:${PUT})${AT_VENUE}`,
  // Past tense only: "how much can I borrow" would read "can" as the token, and asks something else.
  String.raw`(?:what|${HOW_MUCH}) i (?:${PLACED})${AT_VENUE}`,
  String.raw`(?:what|${HOW_MUCH}) (?:can i|could i|i can|i could|am i able to) (?:${TAKE})${AT_VENUE}`,
  String.raw`(?:what(?:'s| is|s)?|anything|is anything|is there anything)(?: available| ready| left| waiting)? (?:to|for) (?:${TAKE})${AT_VENUE}`,
  String.raw`(?:what(?:'s| is|s)|anything|is anything) (?:${PLACED}|cooling|claimable|withdrawable|owed)${AT_VENUE}`,
  String.raw`do i have (?:(?:any|some) )?(?:open |current |active )?(?:${HOLDINGS})${AT_VENUE}`,
  String.raw`do i have (?:anything|money|any money|(?:any )?${TOKEN}) (?:${PLACED})${AT_VENUE}`,
  String.raw`(?:what|how much)(?: do| did)? i owe${AT_VENUE}`,
  'do i owe anything',
  String.raw`where(?:'s|s| is| are| has| have)(?: all)? my (?:${MONEY})(?: gone| at| kept| now| sitting)?`,
  String.raw`where did(?: all)? my (?:${MONEY}) go`,
  String.raw`where my (?:${MONEY}) (?:is|are)`,
  String.raw`where (?:have|did) i (?:put|${PUT})(?: my (?:${MONEY}))?`,
].map((shape) => new RegExp(`^(?:${shape})$`))

/** What only frames the question. "Get" and "give me" stay out: "get my deposits" asks to withdraw. */
const LEAD_IN =
  /^(?:please )?(?:(?:can|could|would|will) you )?(?:please )?(?:show|tell|list|view|display|check|see|pull up|look at)(?: me)? /
const SOFTENER = /^(?:hey|hi|ok|okay|so|and)[, ]+/
const TRAILER =
  / (?:please|pls|right now|now|so far|here|at the moment|currently|today|again|on this chain)$/

/** Whether a message asks where the person's money is, rather than what their wallet holds. */
export function asksForPositions(text: string): boolean {
  const clean = text
    .trim()
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/[?.!\s]+$/, '')
    .replace(SOFTENER, '')
    .replace(LEAD_IN, '')
    .replace(TRAILER, '')
  return POSITION_QUESTIONS.some((shape) => shape.test(clean))
}

const NOT_READ = "I couldn't read your positions just now, so I won't guess. Try again in a moment."
const NOT_CONNECTED = "Connect your wallet and ask again, and I'll read what you have."
const WALLET_NOTE = `Tokens sitting in your wallet aren't listed here. Ask "what's my balance" for those.`
const NO_NEXT_STEP = "I can't act on this one from here yet."

type Section = VenuePosition['slot'] | 'collateral'

const SECTIONS: readonly (readonly [Section, string])[] = [
  ['supplied', 'Supplied'],
  ['collateral', 'Collateral'],
  ['staked', 'Staked'],
  ['borrowed', 'Borrowed'],
  ['cooling', 'Cooling down'],
  ['claimable', 'Ready to claim'],
]

const EXIT_OF: Record<VenuePosition['slot'], ChainActionKind> = {
  supplied: 'withdraw',
  staked: 'unstake',
  borrowed: 'repay',
  cooling: 'claim',
  claimable: 'claim',
}

/** Only what `parse-action` can read back is offered, since the words are there to be typed. */
const TYPABLE_SYMBOL = new RegExp(`^${TOKEN}$`, 'i')
const TYPABLE_VENUE = /^[a-z0-9][a-z0-9 .-]{1,30}$/i
const TYPABLE_STREAM = /^[a-z0-9]{1,64}$/i

function venueWords(venue: VenueHoldings, preposition: string): string {
  const named = [venue.name, venue.id].find((word) => TYPABLE_VENUE.test(word))
  return named === undefined ? '' : ` ${preposition} ${named}`
}

/** What to type next, or nothing if no sentence here would do it. */
function nextWords(position: VenuePosition, venue: VenueHoldings): string | undefined {
  if (position.id !== undefined) {
    return venue.kinds.includes('cancel') && TYPABLE_STREAM.test(position.id)
      ? `cancel stream ${position.id}${venueWords(venue, 'from')}`
      : undefined
  }
  if (!venue.kinds.includes(EXIT_OF[position.slot]) || !TYPABLE_SYMBOL.test(position.symbol)) {
    return undefined
  }
  const { symbol } = position
  switch (position.slot) {
    case 'supplied':
      return `withdraw all ${symbol}${venueWords(venue, 'from')}`
    case 'staked':
      return `unstake all ${symbol}${venueWords(venue, 'from')}`
    case 'borrowed':
      return `repay all ${symbol}${venueWords(venue, 'on')}`
    case 'cooling':
    case 'claimable':
      return `claim ${symbol}${venueWords(venue, 'from')}`
  }
}

export function readyIn(hours: number | undefined): string | undefined {
  if (hours === undefined || !Number.isFinite(hours)) return undefined
  if (hours < 1) return 'in under an hour'
  const rounded = Math.round(hours)
  if (rounded === 1) return 'in about an hour'
  return rounded < 48 ? `in about ${rounded} hours` : `in about ${Math.round(hours / 24)} days`
}

function positionLine(position: VenuePosition, venue: VenueHoldings): string {
  const held = `• ${position.amount} ${position.symbol} on ${venue.name}`
  const words = nextWords(position, venue)
  if (position.slot === 'cooling') {
    const when = readyIn(position.readyInHours)
    const timing =
      when === undefined
        ? `${held}. The chain doesn't say when it's ready.`
        : `${held}, ready ${when}.`
    return words === undefined ? timing : `${timing} Then type "${words}"`
  }
  return words === undefined ? `${held}. ${NO_NEXT_STEP}` : `${held}: type "${words}"`
}

interface ReplyParts {
  rows: readonly { section: Section; line: string }[]
  unread: readonly string[]
  anyRead: boolean
  chainName: string
  /** Said when everything could be read and nothing is there. */
  nothing: string
  notes: readonly string[]
}

function compose({ rows, unread, anyRead, chainName, nothing, notes }: ReplyParts): string {
  const parts: string[] = []
  if (rows.length > 0) {
    parts.push(`Here's what I can read on ${chainName}:`)
    for (const [section, heading] of SECTIONS) {
      const lines = rows.filter((row) => row.section === section).map((row) => row.line)
      if (lines.length > 0) parts.push(heading, ...lines)
    }
  } else if (unread.length === 0) {
    parts.push(nothing)
  } else if (anyRead) {
    parts.push(`Nothing shows on the apps I could read on ${chainName}.`)
  }
  if (unread.length > 0) {
    parts.push(`I couldn't read ${unread.join(', ')}, so I can't say what you have there.`)
  }
  parts.push(...notes, WALLET_NOTE)
  return parts.join('\n')
}

export function positionsReply(report: PositionsReport | undefined, chainName: string): string {
  if (report === undefined || report.venues.length + report.unread.length === 0) return NOT_READ
  const rows = report.venues.flatMap((venue) =>
    venue.positions.map((position) => ({
      section: position.slot,
      line: positionLine(position, venue),
    }))
  )
  return compose({
    rows,
    unread: report.unread.map((venue) => venue.name),
    anyRead: report.venues.length > 0,
    chainName,
    nothing: `You have nothing deposited, staked, borrowed or waiting to be claimed on ${chainName}.`,
    notes: [],
  })
}

/** One thing held at a venue, as a row of the History page. */
export interface PositionRow {
  key: string
  title: string
  /** What the money is doing, in one word or two: Supplied, Staked, Borrowed. */
  label: string
  venueName: string
  note: string
  symbol: string
  amount: string
  venueId: string
  /** Taking some out. Absent where this venue can't, or where only all of it can go. */
  out?: PositionMove
  /** Adding to it. Absent where this venue can't. */
  into?: PositionMove
  /** All of it at once, built from the same words the chat reads. */
  whole?: { label: string; request: ChainActionRequest }
}

export interface PositionMove {
  kind: ChainActionKind
  label: string
}

const ROW_OF: Record<
  VenuePosition['slot'],
  { title: (venue: string) => string; label: string; note: string }
> = {
  supplied: { title: (v) => `Supplied to ${v}`, label: 'Supplied', note: 'earning' },
  staked: { title: (v) => `Staked on ${v}`, label: 'Staked', note: 'earning' },
  borrowed: { title: (v) => `Borrowed from ${v}`, label: 'Borrowed', note: 'owed' },
  cooling: { title: (v) => `Cooling down on ${v}`, label: 'Cooling down', note: 'on its way' },
  claimable: { title: (v) => `Ready to claim on ${v}`, label: 'Ready to claim', note: 'ready' },
}

const OUT_OF: Partial<Record<VenuePosition['slot'], PositionMove>> = {
  supplied: { kind: 'withdraw', label: 'Withdraw' },
  staked: { kind: 'unstake', label: 'Unstake' },
  borrowed: { kind: 'repay', label: 'Repay' },
}

const INTO: Partial<Record<VenuePosition['slot'], PositionMove>> = {
  supplied: { kind: 'supply', label: 'Top up' },
  staked: { kind: 'stake', label: 'Top up' },
  borrowed: { kind: 'borrow', label: 'Borrow more' },
}

function wholeOf(
  position: VenuePosition,
  venue: VenueHoldings
): { label: string; request: ChainActionRequest } | undefined {
  // A cooling exit has nothing to collect yet, so offering the claim would only be refused.
  if (position.slot === 'cooling') return undefined
  const words = nextWords(position, venue)
  const request = words === undefined ? undefined : parseChainAction(words)
  if (request === undefined || request === null) return undefined
  if (position.id !== undefined) return { label: 'Cancel stream', request }
  if (position.slot === 'claimable') return { label: 'Claim', request }
  const out = OUT_OF[position.slot]
  return out === undefined ? undefined : { label: `${out.label} all`, request }
}

function usable(
  move: PositionMove | undefined,
  position: VenuePosition,
  venue: VenueHoldings
): PositionMove | undefined {
  if (move === undefined || position.id !== undefined) return undefined
  return venue.kinds.includes(move.kind) ? move : undefined
}

/** Every position in a report as a row, named after the venue the money is at. */
export function positionRows(report: PositionsReport): PositionRow[] {
  return report.venues.flatMap((venue) =>
    venue.positions.map((position, i) => {
      const { title, label, note } = ROW_OF[position.slot]
      const when = position.slot === 'cooling' ? readyIn(position.readyInHours) : undefined
      const out = usable(OUT_OF[position.slot], position, venue)
      const into = usable(INTO[position.slot], position, venue)
      const whole = wholeOf(position, venue)
      return {
        key: `${venue.id}-${position.slot}-${position.symbol}-${position.id ?? i}`,
        title: title(venue.name),
        label,
        venueName: venue.name,
        note: when === undefined ? note : `ready ${when}`,
        symbol: position.symbol,
        amount: position.amount,
        venueId: venue.id,
        ...(out !== undefined ? { out } : {}),
        ...(into !== undefined ? { into } : {}),
        ...(whole !== undefined ? { whole } : {}),
      }
    })
  )
}

/** Some of a position, as the same request a typed "withdraw 5 USDC from NAVI" makes. */
export function positionRequest(
  row: Pick<PositionRow, 'symbol' | 'venueId'>,
  move: PositionMove,
  amount: string
): ChainActionRequest {
  return { kind: move.kind, amount, tokenIn: row.symbol, venue: row.venueId }
}

/** The rows at a venue named in chat, or every row if it names none of them. */
export function rowsAt(rows: readonly PositionRow[], venue: string | undefined): PositionRow[] {
  if (venue === undefined) return [...rows]
  const wanted = venue.toLowerCase().replace(/[^a-z0-9]/g, '')
  const plain = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '')
  const at = rows.filter(
    (row) => plain(row.venueId).includes(wanted) || plain(row.title).includes(wanted)
  )
  return at.length > 0 ? at : [...rows]
}

const MANAGE_VERBS = String.raw`(?:withdraw|take out|pull out|remove|exit|close|manage|top up|add to|unstake|repay)`
const VENUE_WORD = String.raw`[a-z][a-z0-9 .-]{1,30}`
const MANAGE_POSITION = new RegExp(
  String.raw`^${MANAGE_VERBS}(?: from| of)?(?: my)?(?: (${VENUE_WORD}?))? (?:positions?|deposits?|stakes?|loans?)$`
)
const MANAGE_VENUE = new RegExp(
  String.raw`^(?:withdraw|take out|pull out|exit|top up)(?: my (?:money|funds))?(?: from| out of| of| on| in) (?:my )?(${VENUE_WORD})$`
)
const MANAGE_LEAD_IN =
  /^(?:please |i want to |i'd like to |id like to |i wanna |let me |help me |can you |could you |can i |could i )+/

/**
 * Whether a message asks to act on a position without saying how much: "withdraw from my position",
 * "top up my NAVI position", "withdraw from navi". The card lets them choose. Anything with a figure,
 * or naming a token to take, is a request of its own and is left for the action parser.
 */
export function asksToManagePosition(text: string): { venue?: string } | null {
  const clean = text
    .trim()
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/[?.!\s]+$/, '')
    .replace(MANAGE_LEAD_IN, '')
  if (/\d/.test(clean)) return null
  const position = MANAGE_POSITION.exec(clean)
  const venue = position !== null ? position[1] : MANAGE_VENUE.exec(clean)?.[1]
  if (position !== null || venue !== undefined) {
    const named = venue?.replace(/^(?:the|open|lending|staking)\s+/, '').trim()
    return named === undefined || named === '' || named === 'open' ? {} : { venue: named }
  }
  return null
}

const BLEND = 'Blend'

function blendLine(balance: BlendBalance, suffix = ''): string {
  const amount = balance.display.includes('.')
    ? balance.display.replace(/\.?0+$/, '')
    : balance.display
  return `• ${amount} ${balance.symbol} on ${BLEND}${suffix}`
}

/**
 * Stellar reads Blend through its own route and acts on it from the History tab, not by a typed
 * sentence. Supply and collateral stay apart: only collateral can be taken from the person.
 */
export function blendPositionsReply(blend: BlendPositions | undefined): string {
  const rows =
    blend === undefined
      ? []
      : [
          ...blend.supplied.map((b) => ({ section: 'supplied' as const, line: blendLine(b) })),
          ...blend.collateral.map((b) => ({
            section: 'collateral' as const,
            line: blendLine(b, '. It can be liquidated if what you owe outgrows it.'),
          })),
          ...blend.borrowed.map((b) => ({ section: 'borrowed' as const, line: blendLine(b) })),
        ]
  return compose({
    rows,
    unread: blend === undefined ? [BLEND] : [],
    anyRead: blend !== undefined,
    chainName: 'Stellar',
    nothing: `You have nothing supplied or borrowed on ${BLEND}.`,
    notes: [
      ...(blend?.health.liquidatable === true
        ? [`Your ${BLEND} position can be liquidated now.`]
        : []),
      ...(rows.length > 0 ? [`To withdraw or repay on ${BLEND}, open the History tab.`] : []),
      `${BLEND} is the one place I can read on Stellar.`,
    ],
  })
}

async function readJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  try {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    })
    return response.ok ? await response.json() : undefined
  } catch {
    return undefined
  }
}

/** The answer to a position question, read when asked. A read that fails is said, never shown as nothing. */
export async function readPositionsReply(
  chain: string,
  chainName: string,
  account: string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  if (account === undefined) return NOT_CONNECTED
  const query = `account=${encodeURIComponent(account)}`
  if (chain === 'stellar') {
    const body = (await readJson(`/api/lend/position?${query}`, fetchImpl)) as
      | { positions?: Partial<BlendPositions> }
      | undefined
    const blend = body?.positions
    const whole =
      Array.isArray(blend?.supplied) &&
      Array.isArray(blend?.collateral) &&
      Array.isArray(blend?.borrowed)
    return blendPositionsReply(whole ? (blend as BlendPositions) : undefined)
  }
  const body = (await readJson(`/api/chain/${chain}/positions?${query}`, fetchImpl)) as
    | Partial<PositionsReport>
    | undefined
  const whole = Array.isArray(body?.venues) && Array.isArray(body?.unread)
  return positionsReply(whole ? (body as PositionsReport) : undefined, chainName)
}
