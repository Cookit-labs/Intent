import { isOffCurveAddress, type Address } from '@solana/kit'

import { sendRefusal } from '../recipient'
import { ChainActionRefused, type ChainWithActions, type PreparedAction } from '../types'
import { monadNameReader, resolveAllDomainsMonad, type MonadNameReader } from './alldomains-monad'
import { resolveAllDomainsSolana } from './alldomains-solana'
import { resolveSnsName, resolveSolName } from './sns'
import { solanaNameRpc, type SolanaNameRpc } from './solana-rpc'
import { resolveSuiName, suiNameReader, type SuiNameReader } from './suins'
import { nameRefused, notReadWords, recipientName, type RecipientName } from './tlds'

/** Where a name read to. Everything after this point deals only in `address`. */
export interface ResolvedName {
  name: string
  address: string
  /** Named on the card. */
  source: string
  caution?: string | undefined
}

export interface NameReaders {
  solana: () => SolanaNameRpc
  monad: () => MonadNameReader
  sui: () => SuiNameReader
}

const LIVE: NameReaders = { solana: solanaNameRpc, monad: monadNameReader, sui: suiNameReader }

const SOLD_NAME =
  'A SuiNS name keeps pointing to the address last set, even after the name is sold, so check this is still who you mean.'

async function read(
  typed: RecipientName,
  readers: NameReaders
): Promise<Omit<ResolvedName, 'name'>> {
  const { name, label, tld } = typed
  if (typed.chain === 'sui') {
    return {
      address: await resolveSuiName(readers.sui(), name, label),
      source: 'SuiNS',
      caution: SOLD_NAME,
    }
  }
  if (typed.chain === 'monad') {
    return {
      address: await resolveAllDomainsMonad(readers.monad(), name, label, tld),
      source: 'AllDomains',
    }
  }
  const rpc = readers.solana()
  const sns = tld === 'sol' || tld === 'sns'
  const address =
    tld === 'sol'
      ? await resolveSolName(rpc, name, label)
      : tld === 'sns'
        ? await resolveSnsName(rpc, name, label)
        : await resolveAllDomainsSolana(rpc, name, label, tld)
  // A program holds no key, so what is sent to it is stranded. sns-sdk-kit's default refuses too.
  if (isOffCurveAddress(address as Address)) {
    throw nameRefused(
      name,
      'is held by a program, not a wallet, so money sent there could be stuck.'
    )
  }
  return { address, source: sns ? 'the Solana Name Service' : 'AllDomains' }
}

/**
 * Reads a name on its own chain. Any failure is a refusal, never a guess: what a person can act on
 * passes through in its own words, and anything else (a dead node, bytes that don't decode) is
 * reported as an unread name.
 */
export async function resolveName(
  chain: ChainWithActions,
  typed: RecipientName,
  readers: Partial<NameReaders> = {}
): Promise<ResolvedName> {
  const refusal = sendRefusal(chain, undefined, typed.name)
  if (refusal !== undefined) throw new ChainActionRefused(refusal)
  try {
    return { name: typed.name, ...(await read(typed, { ...LIVE, ...readers })) }
  } catch (e) {
    if (e instanceof ChainActionRefused) throw e
    throw new ChainActionRefused(notReadWords(typed.name))
  }
}

/**
 * What a recipient resolves to, or nothing if it is an address already. The resolved address has to
 * pass everything a typed one does, so the same check runs on it.
 */
export async function resolveRecipient(
  chain: ChainWithActions,
  symbol: string,
  recipient: string,
  account: string,
  readers: Partial<NameReaders> = {}
): Promise<ResolvedName | undefined> {
  const refusal = sendRefusal(chain, symbol, recipient, account)
  if (refusal !== undefined) throw new ChainActionRefused(refusal)
  const typed = recipientName(recipient)
  if (typed === undefined) return undefined
  const resolved = await resolveName(chain, typed, readers)
  const afterName = sendRefusal(chain, symbol, resolved.address, account)
  if (afterName !== undefined) {
    throw new ChainActionRefused(`${resolved.name} points to ${resolved.address}. ${afterName}`)
  }
  return resolved
}

/** Only an EVM or Sui address may differ by case, and base58 never. */
function sameAddress(a: string, b: string): boolean {
  return a.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * The card for a request that named someone. A venue that issued any other recipient than the one
 * the name read to is stopped here, since the person would read one address and sign another.
 */
export function withResolvedName(prepared: PreparedAction, named: ResolvedName): PreparedAction {
  const { name, address, source, caution } = named
  const issued = prepared.context?.['recipient']
  if (issued !== undefined && !sameAddress(issued, address)) {
    throw new ChainActionRefused(
      `This was built for a different address than ${name} points to, so it was stopped. Nothing was signed or sent.`
    )
  }
  return {
    ...prepared,
    summary: prepared.summary.includes(address)
      ? prepared.summary.replace(address, `${name} (${address})`)
      : `${prepared.summary} ${name} is ${address}.`,
    notes: [
      `${name} points to ${address}, read just now from ${source}. That address is what gets paid, so check it is who you mean.`,
      ...(caution === undefined ? [] : [caution]),
      ...prepared.notes,
    ],
  }
}
