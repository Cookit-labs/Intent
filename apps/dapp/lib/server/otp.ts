import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import Redis from 'ioredis'

/**
 * One-time codes, in Redis.
 *
 * Redis rather than Postgres because every value here is meant to expire:
 * codes, attempt counters and rate-limit windows all have a natural TTL, and
 * `EXPIRE` does that correctly without a cleanup job that can silently stop
 * running and leave valid codes alive forever.
 */
const globalForRedis = globalThis as unknown as { intentRedis?: Redis }

function getRedis(): Redis {
  const existing = globalForRedis.intentRedis
  if (existing !== undefined) return existing

  const url = process.env['REDIS_URL']
  if (url === undefined || url === '') {
    throw new Error('REDIS_URL is not set. Run `docker compose up -d` and check .env.local')
  }

  const client = new Redis(url, { maxRetriesPerRequest: 2 })
  globalForRedis.intentRedis = client
  return client
}

export const CODE_TTL_SECONDS = 10 * 60
const MAX_ATTEMPTS = 5
/** Shortest gap between two sends to the same address. */
const RESEND_COOLDOWN_SECONDS = 60
/** Sends allowed per address per hour. */
const HOURLY_SEND_LIMIT = 5

const codeKey = (email: string): string => `otp:code:${email}`
const attemptsKey = (email: string): string => `otp:attempts:${email}`
const cooldownKey = (email: string): string => `otp:cooldown:${email}`
const hourlyKey = (email: string): string => `otp:hourly:${email}`

/**
 * Codes are stored hashed, never in plaintext. A Redis snapshot, a misconfigured
 * `KEYS *`, or an operator glancing at the datastore should not yield a working
 * login code for someone else's account.
 */
function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

/** Six digits via a CSPRNG. `Math.random` is predictable and unfit for this. */
function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export interface RateLimitResult {
  allowed: boolean
  /** Seconds until another send is permitted, when blocked. */
  retryAfter: number
  reason?: 'cooldown' | 'hourly'
}

export async function checkSendRateLimit(email: string): Promise<RateLimitResult> {
  const redis = getRedis()

  const cooldown = await redis.ttl(cooldownKey(email))
  if (cooldown > 0) return { allowed: false, retryAfter: cooldown, reason: 'cooldown' }

  const sends = await redis.get(hourlyKey(email))
  if (sends !== null && Number(sends) >= HOURLY_SEND_LIMIT) {
    const ttl = await redis.ttl(hourlyKey(email))
    return { allowed: false, retryAfter: ttl > 0 ? ttl : 3600, reason: 'hourly' }
  }

  return { allowed: true, retryAfter: 0 }
}

/** Issues a code and returns the plaintext, which only the email may contain. */
export async function issueCode(email: string): Promise<string> {
  const redis = getRedis()
  const code = generateCode()

  await redis
    .multi()
    .set(codeKey(email), hashCode(code), 'EX', CODE_TTL_SECONDS)
    .del(attemptsKey(email))
    .set(cooldownKey(email), '1', 'EX', RESEND_COOLDOWN_SECONDS)
    .incr(hourlyKey(email))
    .expire(hourlyKey(email), 3600)
    .exec()

  return code
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'invalid' | 'too_many_attempts' }

/**
 * Checks a submitted code, consuming it on success.
 *
 * A wrong guess burns an attempt, and the code dies after `MAX_ATTEMPTS`. That
 * cap is what makes a 6-digit secret safe: without it, a million guesses is a
 * few minutes of scripted requests.
 */
export async function verifyCode(email: string, submitted: string): Promise<VerifyResult> {
  const redis = getRedis()

  const stored = await redis.get(codeKey(email))
  if (stored === null) return { ok: false, reason: 'expired' }

  const attempts = await redis.incr(attemptsKey(email))
  await redis.expire(attemptsKey(email), CODE_TTL_SECONDS)

  if (attempts > MAX_ATTEMPTS) {
    await redis.del(codeKey(email))
    return { ok: false, reason: 'too_many_attempts' }
  }

  // Constant-time compare so response timing cannot reveal a correct prefix.
  const a = Buffer.from(hashCode(submitted), 'hex')
  const b = Buffer.from(stored, 'hex')
  const match = a.length === b.length && timingSafeEqual(a, b)

  if (!match) return { ok: false, reason: 'invalid' }

  await redis.multi().del(codeKey(email)).del(attemptsKey(email)).exec()
  return { ok: true }
}
