import { ChainActionRefused, type ChainWithActions } from '../types'

/** Client-safe: the chat refuses a name on the wrong chain from here, before any read. */

/**
 * The endings this app reads, each on the one chain it reads them on. Solana's AllDomains list is
 * kept to four on purpose: its TLD House also holds `.sol`, `.eth`, `.btc`, `.com`, `.x` and others
 * that read as somebody else's name, so a new ending has to be added here by hand. Monad's are what
 * ANS root `listTlds()` returned on 2026-11-05.
 */
export const NAME_TLDS: Record<ChainWithActions, readonly string[]> = {
  solana: ['sol', 'sns', 'abc', 'bonk', 'poor', 'skr'],
  sui: ['sui'],
  monad: ['mon', 'nad', 'chog', 'molandak', 'moyaki', 'salmonad', 'mokadel', 'mouch'],
  near: [],
  avalanche: [],
}

const TLD_CHAIN: ReadonlyMap<string, ChainWithActions> = new Map(
  (Object.entries(NAME_TLDS) as [ChainWithActions, readonly string[]][]).flatMap(([chain, tlds]) =>
    tlds.map((tld) => [tld, chain] as const)
  )
)

/** Plain letters and digits only, so no look-alike character can stand in for a real name. */
const LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface RecipientName {
  /** In lower case, the only form these registries hold. */
  name: string
  /** The part before the ending. */
  label: string
  tld: string
  chain: ChainWithActions
  sub: boolean
  readable: boolean
}

/** The name in what a person typed, or nothing if it ends in no ending this app reads. */
export function recipientName(text: string): RecipientName | undefined {
  const name = text.trim().toLowerCase()
  const parts = name.split('.')
  if (parts.length < 2) return undefined
  const tld = parts[parts.length - 1] as string
  const chain = TLD_CHAIN.get(tld)
  if (chain === undefined) return undefined
  const labels = parts.slice(0, -1)
  return {
    name,
    label: labels[labels.length - 1] as string,
    tld,
    chain,
    sub: labels.length > 1,
    readable: labels.every((label) => LABEL.test(label)),
  }
}

export const NOTHING_MOVED = 'Nothing was signed or sent.'
const USE_ADDRESS = 'Use the wallet address instead.'

export function nameRefused(name: string, words: string): ChainActionRefused {
  return new ChainActionRefused(`${name} ${words} ${USE_ADDRESS} ${NOTHING_MOVED}`)
}

export const NOT_REGISTERED = "isn't registered, so there is no one to send to."
export const NOT_CONFIRMED = "could not be confirmed as a real record, so I won't send to it."
export const EXPIRED = 'has expired, so it may belong to someone else by now.'

export function notReadWords(name: string): string {
  return `${name} could not be read from the chain just now, so I won't guess where it points. Try again, or use the wallet address. ${NOTHING_MOVED}`
}
