import { defineConfig, devices } from '@playwright/test'

/**
 * Browser smoke pass against a production build of the dapp.
 *
 * Deterministic on purpose: no wallet, no model key, no database. The server
 * env below blanks every provider key so a developer's `.env.local` cannot put
 * real agents in the race, and the specs assert only on what the pages render
 * in that state. Chromium only; the pages have no browser-specific code.
 */
const PORT = 3006
const BASE_URL = `http://localhost:${PORT}`

/**
 * How the server is started.
 *
 * The default is the plan's `next build && next start`. `E2E_SERVER=start`
 * skips the build because one already exists — CI downloads the build the
 * typescript job made rather than making a second one. `E2E_SERVER=dev` runs
 * the suite against the dev server, for Windows, where `next build` fails in
 * the `/icon` prerender.
 */
function serverCommand(): string {
  switch (process.env['E2E_SERVER']) {
    case 'dev':
      return `next dev -p ${PORT}`
    case 'start':
      return `next start -p ${PORT}`
    default:
      return `next build && next start -p ${PORT}`
  }
}

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: process.env['CI'] !== undefined,
  retries: process.env['CI'] !== undefined ? 1 : 0,
  reporter: process.env['CI'] !== undefined ? [['list'], ['html', { open: 'never' }]] : 'list',
  // Generous because the dev server compiles each page and route on its
  // first hit, and the compose spec waits on two of those in a row.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    // A retried run records the attempt, so a flake that passes on retry still
    // leaves evidence of the first failure.
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: serverCommand(),
    url: BASE_URL,
    reuseExistingServer: process.env['CI'] === undefined,
    // The default command builds first.
    timeout: 10 * 60 * 1000,
    env: {
      AGENT_BRAIN: 'mock',
      SKIP_LIVE: '1',
      NEXT_TELEMETRY_DISABLED: '1',
      // Blank rather than unset: Next only fills a variable from `.env.local`
      // when the process has none, so a blank here is what keeps a local key
      // or database out of the run. The app treats blank as absent.
      DATABASE_URL: '',
      AGENT_BRAINS: '',
      DEEPSEEK_API_KEY: '',
      GROQ_API_KEY: '',
      OPENROUTER_API_KEY: '',
      SOROSWAP_API_KEY: '',
      DEFINDEX_API_KEY: '',
      NOETHER_API_URL: '',
      SPONSOR_SECRET_KEY: '',
      REDIS_URL: '',
    },
  },
})
