/* eslint-disable no-console */

/**
 * A development scheduler for the standing-rules tick.
 *
 * Production calls POST /api/standing/tick from a cron or a hosted scheduled
 * function; this is the same call in a loop, for a laptop. Run alongside
 * `pnpm dev` with:
 *
 *   pnpm standing:tick
 *
 * which reads STANDING_TICK_SECRET and APP_URL from .env.local. Each pass
 * prints the counts the route returns — rules evaluated, rules fired, emails
 * sent — so a rule that should have fired and did not is visible here first.
 */

const APP_URL =
  process.env['APP_URL'] ?? process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3001'
const SECRET = process.env['STANDING_TICK_SECRET']

/** The route is idempotent, so the interval only bounds how late a rule fires. */
const INTERVAL_MS = 60_000

async function tick(secret: string): Promise<void> {
  const at = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/standing/tick`, {
      method: 'POST',
      headers: { 'x-tick-secret': secret },
    })
    const body = await res.text()
    console.log(`${at} ${res.status} ${body}`)
  } catch (e) {
    // The dev server may not be up yet. Say so and try again next time.
    console.error(`${at} tick failed:`, e instanceof Error ? e.message : e)
  }
}

function main(): void {
  if (SECRET === undefined || SECRET === '') {
    console.error('STANDING_TICK_SECRET is not set. Add it to .env.local (16+ characters).')
    process.exit(1)
  }

  console.log(`ticking ${APP_URL}/api/standing/tick every ${INTERVAL_MS / 1000}s`)
  void tick(SECRET)
  setInterval(() => void tick(SECRET), INTERVAL_MS)
}

main()
