import { recipientKind } from './kind'

/**
 * What a name resolved to last time, kept in this browser.
 *
 * A name is a pointer somebody else controls. The registry entry can be
 * updated, the federation server can answer differently, and either way the
 * payment goes where the name points *now*. This book exists so the card can
 * say when that changed: "last time deon.xlm was G…ABC, today it is G…XYZ" is
 * the one sentence that turns a redirected name from a silent loss into a
 * question.
 *
 * The memo counts as much as the address. An exchange's federation answer is
 * one pooled account for everybody and a memo saying whose deposit this is;
 * a changed memo with the same address is a redirect, and "same address as
 * last time" would be reassurance at exactly the wrong moment.
 *
 * **It decides nothing.** The server resolves every payment fresh, at build
 * and again at submit; the book is never a substitute for that answer, only
 * a comparison against it. Raw addresses are not pinned — a key is its own
 * address, and there is nothing to compare it against later.
 */

export type PinStatus =
  | { status: 'new' }
  | { status: 'known' }
  | {
      status: 'changed'
      /** Which of the two moved. The address takes precedence when both did. */
      what: 'address' | 'memo'
      previous: string
      previousMemo?: string
      pinnedAt: string
    }

const STORAGE_KEY = 'intent.addressbook.v1'

interface Entry {
  address: string
  memo?: string
  pinnedAt: string
}

type Book = Record<string, Entry>

function read(): Book {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Book
  } catch {
    // Private-mode browsers throw on access, and a corrupt value parses to
    // nothing. Either way the honest answer is "never seen".
    return {}
  }
}

function write(book: Book): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(book))
  } catch {
    /* see read() */
  }
}

function keyOf(name: string): string {
  return name.trim().toLowerCase()
}

function isName(input: string): boolean {
  const kind = recipientKind(input)
  return kind === 'soroban-domain' || kind === 'federation'
}

export function checkRecipient(name: string, address: string, memo?: string): PinStatus {
  const entry = read()[keyOf(name)]
  if (entry === undefined || typeof entry.address !== 'string') return { status: 'new' }

  const changed = (what: 'address' | 'memo'): PinStatus => ({
    status: 'changed',
    what,
    previous: entry.address,
    ...(entry.memo !== undefined ? { previousMemo: entry.memo } : {}),
    pinnedAt: entry.pinnedAt,
  })

  if (entry.address !== address) return changed('address')
  if ((entry.memo ?? '') !== (memo ?? '')) return changed('memo')
  return { status: 'known' }
}

/** Records where a name pointed, after a payment to it settled. Overwrites. */
export function pinRecipient(name: string, address: string, memo?: string): void {
  if (!isName(name)) return
  const book = read()
  book[keyOf(name)] = {
    address,
    ...(memo !== undefined && memo !== '' ? { memo } : {}),
    pinnedAt: new Date().toISOString(),
  }
  write(book)
}
