import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { verifyWeaveSignature } from '../weave/webhook'

const SECRET = 'whsec_test'
const NOW = 1_800_000_000
const BODY = '{"event":"order.completed","data":{"id":"ord_1"}}'

function sign(body: string | Buffer, timestamp: string, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex')
}

describe('verifyWeaveSignature', () => {
  it('accepts a fresh signature over timestamp and body', () => {
    const ts = String(NOW - 10)
    expect(verifyWeaveSignature(BODY, sign(BODY, ts), ts, SECRET, NOW)).toBe(true)
  })

  it('signs the raw bytes, so bytes that are not valid text still verify', () => {
    const raw = Buffer.from([0x7b, 0xff, 0xfe, 0x7d])
    const ts = String(NOW)
    expect(verifyWeaveSignature(raw, sign(raw, ts), ts, SECRET, NOW)).toBe(true)
  })

  it('refuses a changed body', () => {
    const ts = String(NOW)
    expect(verifyWeaveSignature(`${BODY} `, sign(BODY, ts), ts, SECRET, NOW)).toBe(false)
  })

  it('refuses a timestamp the signature does not cover', () => {
    const ts = String(NOW)
    expect(verifyWeaveSignature(BODY, sign(BODY, ts), String(NOW - 1), SECRET, NOW)).toBe(false)
  })

  it('refuses a signature older than five minutes', () => {
    const ts = String(NOW - 301)
    expect(verifyWeaveSignature(BODY, sign(BODY, ts), ts, SECRET, NOW)).toBe(false)
    const edge = String(NOW - 300)
    expect(verifyWeaveSignature(BODY, sign(BODY, edge), edge, SECRET, NOW)).toBe(true)
  })

  it('refuses a timestamp far in the future', () => {
    const ts = String(NOW + 301)
    expect(verifyWeaveSignature(BODY, sign(BODY, ts), ts, SECRET, NOW)).toBe(false)
  })

  it('fails closed with no secret, even for a signature made with an empty one', () => {
    const ts = String(NOW)
    expect(verifyWeaveSignature(BODY, sign(BODY, ts, ''), ts, '', NOW)).toBe(false)
  })

  it('refuses missing or malformed headers', () => {
    const ts = String(NOW)
    expect(verifyWeaveSignature(BODY, null, ts, SECRET, NOW)).toBe(false)
    expect(verifyWeaveSignature(BODY, sign(BODY, ts), null, SECRET, NOW)).toBe(false)
    expect(verifyWeaveSignature(BODY, sign(BODY, ts).slice(7), ts, SECRET, NOW)).toBe(false)
    expect(verifyWeaveSignature(BODY, 'sha256=abc', ts, SECRET, NOW)).toBe(false)
    const soft = `${NOW}.5`
    expect(verifyWeaveSignature(BODY, sign(BODY, soft), soft, SECRET, NOW)).toBe(false)
  })

  it('refuses a signature made with another secret', () => {
    const ts = String(NOW)
    expect(verifyWeaveSignature(BODY, sign(BODY, ts, 'other'), ts, SECRET, NOW)).toBe(false)
  })
})
