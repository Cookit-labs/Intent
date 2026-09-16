import { describe, expect, it } from 'vitest'

import { toBase64Signature } from '../api/auth'

/**
 * Normalising whatever shape a wallet returns a signature in.
 *
 * Wallets disagree and the kit does not settle it: Bitget hands back hex,
 * Freighter passes a string through untouched and base64-encodes only when it
 * receives bytes. Every one of them is typed `string`, so nothing catches the
 * difference until the server rejects it — and it rejects with "signature did
 * not verify for this account", which points at the wrong account rather than
 * the wrong encoding. That misdirection cost real debugging time.
 *
 * The length check is the load-bearing part. `Buffer.from(s, 'base64')` never
 * throws on malformed input, it truncates, so a mangled signature would sail
 * through as a shorter buffer and fail server-side for an unexplained reason.
 */

/** 64 bytes, the only length an ed25519 signature has. */
const RAW = Uint8Array.from({ length: 64 }, (_, i) => (i * 7) % 256)
const BASE64 = Buffer.from(RAW).toString('base64')
const HEX = Buffer.from(RAW).toString('hex')

describe('the shapes wallets actually return', () => {
  it('passes base64 through unchanged', () => {
    expect(toBase64Signature(BASE64)).toBe(BASE64)
  })

  it('converts hex, which Bitget returns', () => {
    expect(toBase64Signature(HEX)).toBe(BASE64)
  })

  it('converts hex whatever its case', () => {
    expect(toBase64Signature(HEX.toUpperCase())).toBe(BASE64)
  })

  it('converts raw bytes, which Freighter can hand back', () => {
    expect(toBase64Signature(RAW)).toBe(BASE64)
  })

  it('converts a byte array that crossed a JSON boundary', () => {
    expect(toBase64Signature(Array.from(RAW))).toBe(BASE64)
  })

  it('converts comma-separated byte values', () => {
    // Not a wallet format. It is what `String(bytes)` produces on a Uint8Array,
    // and that mistake reached a live server during this work — the encoding
    // was wrong and the error blamed the account.
    expect(toBase64Signature(String(RAW))).toBe(BASE64)
  })
})

describe('anything the server could not read is refused here', () => {
  it('refuses a signature of the wrong length', () => {
    const short = Buffer.from(RAW.slice(0, 32)).toString('base64')
    expect(() => toBase64Signature(short)).toThrow(/32-byte signature/)
  })

  it('refuses malformed base64 rather than truncating it', () => {
    // `Buffer.from` does not throw on bad base64, it drops what it cannot
    // decode. Without the length check this would reach the server short.
    expect(() => toBase64Signature('!!!not base64!!!')).toThrow(/signature/)
  })

  it('refuses an empty string', () => {
    expect(() => toBase64Signature('')).toThrow(/cannot read/)
  })

  it('refuses a missing signature', () => {
    expect(() => toBase64Signature(undefined)).toThrow(/cannot read/)
    expect(() => toBase64Signature(null)).toThrow(/cannot read/)
  })

  it('refuses a shape that is not a signature at all', () => {
    expect(() => toBase64Signature({ signature: BASE64 })).toThrow(/cannot read/)
  })

  it('names the length it got, so the failure is diagnosable', () => {
    // "wrong encoding" and "wrong account" are indistinguishable server-side.
    // Saying the length here is what separates them.
    const long = Buffer.alloc(80).toString('base64')
    expect(() => toBase64Signature(long)).toThrow(/80-byte signature; 64 were expected/)
  })

  it('prefers hex at the one length where hex and base64 collide', () => {
    // A 128-character hex-alphabet string is valid hex for 64 bytes and valid
    // base64 for 96. Nothing distinguishes them — not length, not alphabet —
    // so hex wins, because that is what a wallet means at that length. Pinned
    // because an earlier attempt to disambiguate by alphabet, and then by
    // length, silently made Bitget's hex signatures unreachable.
    expect(toBase64Signature(HEX)).toBe(BASE64)
    expect(HEX).toHaveLength(128)
  })
})
