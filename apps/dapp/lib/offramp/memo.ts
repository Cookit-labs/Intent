import { Memo } from '@stellar/stellar-sdk'

import type { Sep24MemoType } from './sep24'

/**
 * The anchor's memo, each way.
 *
 * Small on purpose, because it is the one place the three memo types are
 * handled and the one place a mistake loses a payment silently. The anchor's
 * receiving account is shared; the memo is the only thing that says whose
 * withdrawal a payment belongs to.
 *
 * `hash` is the trap. The anchor sends it base64-encoded; `Memo.hash` in this
 * SDK accepts raw bytes or *hex*, and hands a base64 string straight to the
 * hex parser — verified against the installed build, which throws "Expects a
 * 32 byte hash value or hex encoded string". So it is decoded first, and its
 * length checked, because a 31-byte hash is a different memo.
 */

const MAX_TEXT_BYTES = 28
const MAX_U64 = BigInt('18446744073709551615')

export function memoFromAnchor(value: string, type: Sep24MemoType): Memo {
  switch (type) {
    case 'hash': {
      const bytes = Buffer.from(value, 'base64')
      if (bytes.length !== 32) {
        throw new Error(`anchor hash memo decodes to ${bytes.length} bytes, not 32`)
      }
      return Memo.hash(bytes)
    }
    case 'id': {
      if (!/^\d+$/.test(value) || BigInt(value) > MAX_U64) {
        throw new Error(`anchor id memo "${value}" is not an unsigned 64-bit integer`)
      }
      return Memo.id(value)
    }
    case 'text': {
      if (Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) {
        throw new Error(`anchor text memo is longer than ${MAX_TEXT_BYTES} bytes`)
      }
      return Memo.text(value)
    }
  }
}

/**
 * Whether a decoded transaction's memo is exactly the anchor's.
 *
 * Type and value both, because the anchor matches on both: a text memo whose
 * bytes spell the right id is still not an id memo. Decoded memo values are
 * `Uint8Array` for text and hash and a string for id — verified against the
 * installed SDK rather than assumed.
 */
export function memoMatches(memo: Memo, value: string, type: Sep24MemoType): boolean {
  if (memo.type !== type) return false
  switch (type) {
    case 'hash':
      return Buffer.from(memo.value as Uint8Array).equals(Buffer.from(value, 'base64'))
    case 'text':
      return new TextDecoder().decode(memo.value as Uint8Array) === value
    case 'id':
      return String(memo.value) === value
  }
}
