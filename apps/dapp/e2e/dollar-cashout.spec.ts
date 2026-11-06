import { expect, test, type Page, type Request } from '@playwright/test'

import { BETA_NOTICE_SEEN } from './beta-notice-seen'

/**
 * A cash-out sized in dollars, "$0.8 worth of sol", must race a swap of SOL bought with those
 * dollars, never 0.8 SOL. The price, Weave's currencies and the race are stubbed.
 */
test.use({ storageState: { cookies: [], origins: BETA_NOTICE_SEEN } })
// The chat page takes over a minute on a dev server's first hit.
test.beforeEach(() => test.slow())

const ADDRESS = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg'
const SOL_PRICE = 90.24

async function connectFakeSolanaWallet(page: Page): Promise<void> {
  await page.addInitScript(
    ({ address }) => {
      const account = {
        address,
        publicKey: new Uint8Array(32),
        chains: ['solana:mainnet'],
        features: [],
      }
      const wallet = {
        version: '1.0.0',
        name: 'Fake Solana',
        icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
        chains: ['solana:mainnet'],
        accounts: [account],
        features: {
          'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
          'standard:events': { version: '1.0.0', on: () => () => undefined },
          'solana:signTransaction': {
            version: '1.0.0',
            supportedTransactionVersions: ['legacy', 0],
            signTransaction: async () => [],
          },
        },
      }
      const register = (api: { register: (w: unknown) => void }): void => {
        api.register(wallet)
      }
      window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }))
      window.addEventListener('wallet-standard:app-ready', (e) => {
        register((e as CustomEvent).detail)
      })
    },
    { address: ADDRESS }
  )

  await page.goto('/solana/intents')
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  const steps = page.locator('[data-connect-steps]')
  await steps.getByRole('button', { name: 'Solana' }).click()
  await steps.getByRole('button', { name: 'Fake Solana' }).click()
  await expect(page.getByRole('textbox', { name: 'Describe your intent' })).toBeVisible()
}

/** Stubs what the chat asks before racing, and returns the race requests it makes. */
async function stubAround(page: Page): Promise<Request[]> {
  await page.route('**/api/chain/solana/price**', (r) =>
    r.fulfill({ json: { priceUsd: SOL_PRICE, decimals: 9 } })
  )
  await page.route('**/api/cashout/options**', (r) =>
    r.fulfill({
      json: {
        currencies: [{ code: 'NGN', name: 'Nigerian naira', symbol: '₦', country: 'NG' }],
      },
    })
  )
  const races: Request[] = []
  await page.route('**/api/agents/compete', (r) => {
    races.push(r.request())
    return r.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ type: 'competition:started', competitionId: 'race-1', agents: [{ key: 'groq:qwen', name: 'Qwen3.8 27B', gradient: 'a', model: 'qwen/qwen3.8-27b' }], windowSeconds: 30 })}

`,
    })
  })
  return races
}

async function say(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Describe your intent' }).fill(text)
  await page.getByRole('button', { name: 'Send intent' }).click()
}

for (const text of ['swap $0.8 worth of sol to naira', 'offramp $0.8 worth of sol to naira']) {
  test(`"${text}" races SOL bought with $0.8, not 0.8 SOL`, async ({ page }) => {
    await connectFakeSolanaWallet(page)
    const races = await stubAround(page)
    await say(page, text)

    await expect(page.getByText('$0.8 of SOL at $90.24 is 0.00886524 SOL.')).toBeVisible()
    await expect.poll(() => races.length, { timeout: 30_000 }).toBeGreaterThan(0)
    const body = JSON.stringify(races[0]?.postDataJSON())
    expect(body).toContain('0.00886524')
    expect(body).not.toMatch(/"amount":"0\.8"/)
  })
}
