import { createHmac, timingSafeEqual } from 'node:crypto'

const MAX_AGE_SECONDS = 300

/**
 * Whether a webhook really came from Weave: `sha256=<hex>`, an HMAC-SHA256 of
 * `{timestamp}.{rawBody}` under the webhook secret.
 *
 * Takes the raw bytes, not parsed JSON, because re-serialising changes what the
 * signature covers. The timestamp is inside the signature, so a captured request
 * cannot be replayed with a new one. A missing secret rejects everything.
 */
export function verifyWeaveSignature(
  rawBody: string | Buffer,
  signature: string | null,
  timestamp: string | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  if (secret === '' || signature === null || timestamp === null) return false
  if (!/^\d+$/.test(timestamp)) return false
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_AGE_SECONDS) return false

  const expected = Buffer.from(
    'sha256=' + createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex')
  )
  const given = Buffer.from(signature)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
