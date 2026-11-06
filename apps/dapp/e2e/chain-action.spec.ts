import { expect, test, type Page } from '@playwright/test'

import { BETA_NOTICE_SEEN } from './beta-notice-seen'

/**
 * The chat's path on a chain that is not Stellar, from typed words to a signed
 * result, with a fake wallet the way a real one announces itself. Both server
 * routes are stubbed, so nothing reaches a chain and no agent or price is needed.
 */
test.use({ storageState: { cookies: [], origins: BETA_NOTICE_SEEN } })

const ADDRESS = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg'
const UNSIGNED = btoa('unsigned-transaction')
const SIGNED = btoa('signed-transaction')

async function connectFakeSolanaWallet(page: Page, declines = false): Promise<void> {
  await page.addInitScript(
    ({ address, signed, declines }) => {
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
            signTransaction: async (input: { transaction: Uint8Array }) => {
              if (declines) throw new Error('User rejected the request.')
              ;(window as unknown as { signedInput: string }).signedInput = String.fromCharCode(
                ...input.transaction
              )
              return [
                {
                  signedTransaction: Uint8Array.from(atob(signed), (c) => c.charCodeAt(0)),
                },
              ]
            },
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
    { address: ADDRESS, signed: SIGNED, declines }
  )

  await page.goto('/solana/intents')
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  const steps = page.locator('[data-connect-steps]')
  await steps.getByRole('button', { name: 'Solana' }).click()
  await steps.getByRole('button', { name: 'Fake Solana' }).click()
  await expect(page.getByRole('textbox', { name: 'Describe your intent' })).toBeVisible()
}

async function say(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Describe your intent' }).fill(text)
  await page.getByRole('button', { name: 'Send intent' }).click()
}

async function stubPrepare(page: Page): Promise<() => unknown> {
  let body: unknown
  await page.route('**/api/chain/solana/prepare', async (route) => {
    body = route.request().postDataJSON()
    await route.fulfill({
      json: {
        prepared: {
          venueId: 'jupiter',
          venueName: 'Jupiter',
          kind: 'swap',
          summary: 'Swap 1 USDC for SOL on Jupiter.',
          pay: { amount: '1', symbol: 'USDC' },
          receive: { amount: '0.0061', symbol: 'SOL', approximate: true },
          notes: ['The price can move before this lands.'],
          signing: { family: 'solana', transaction: UNSIGNED },
          context: { requestId: 'r1' },
        },
      },
    })
  })
  return () => body
}

test('a typed swap reaches review, signs, submits and reports the result', async ({ page }) => {
  await connectFakeSolanaWallet(page)
  const prepared = await stubPrepare(page)
  let submitted: unknown
  await page.route('**/api/chain/solana/submit', async (route) => {
    submitted = route.request().postDataJSON()
    await route.fulfill({
      json: { ok: true, hash: 'abc123def456', explorerUrl: 'https://solscan.io/tx/abc123def456' },
    })
  })

  await say(page, 'Swap 1 USDC to SOL')

  await expect(page.getByText('Swap on Jupiter', { exact: true })).toBeVisible()
  await expect(page.getByText(/0.0061 SOL/).first()).toBeVisible()
  await expect(page.getByText('The price can move before this lands.')).toBeVisible()
  expect(prepared()).toEqual({
    account: ADDRESS,
    request: { kind: 'swap', amount: '1', tokenIn: 'USDC', tokenOut: 'SOL' },
  })

  await page.getByRole('button', { name: 'Sign and send' }).click()

  await expect(page.getByRole('link', { name: /abc123/ })).toHaveAttribute(
    'href',
    'https://solscan.io/tx/abc123def456'
  )
  // What the wallet was given is exactly what the server prepared.
  expect(
    await page.evaluate(() => (window as unknown as { signedInput: string }).signedInput)
  ).toBe('unsigned-transaction')
  // And what the server gets back is exactly what the wallet signed.
  expect(submitted).toEqual({
    account: ADDRESS,
    venueId: 'jupiter',
    signed: { family: 'solana', signedTransaction: SIGNED },
    context: { requestId: 'r1' },
  })
})

test('declining in the wallet goes back to review, with nothing sent', async ({ page }) => {
  await connectFakeSolanaWallet(page, true)
  await stubPrepare(page)
  let sent = false
  await page.route('**/api/chain/solana/submit', async (route) => {
    sent = true
    await route.abort()
  })

  await say(page, 'Swap 1 USDC to SOL')
  await page.getByRole('button', { name: 'Sign and send' }).click()

  await expect(page.getByRole('button', { name: 'Sign and send' })).toBeEnabled()
  await expect(page.getByText('User rejected')).toHaveCount(0)
  expect(sent).toBe(false)
})

test('a transaction with no outcome yet says so, and is not shown as a failure', async ({
  page,
}) => {
  await connectFakeSolanaWallet(page)
  await stubPrepare(page)
  await page.route('**/api/chain/solana/submit', (route) =>
    route.fulfill({
      status: 202,
      json: { ok: false, pending: true, error: "Still processing. Don't send it again." },
    })
  )

  await say(page, 'Swap 1 USDC to SOL')
  await page.getByRole('button', { name: 'Sign and send' }).click()

  await expect(page.getByRole('status').filter({ hasText: 'Still processing' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Done' })).toBeVisible()
})

test('a refusal from the server is shown as written', async ({ page }) => {
  await connectFakeSolanaWallet(page)
  await page.route('**/api/chain/solana/prepare', (route) =>
    route.fulfill({ status: 422, json: { error: 'Nothing here can swap on this chain yet.' } })
  )
  await say(page, 'Swap 9000 USDC to SOL')
  await expect(page.getByRole('alert').filter({ hasText: 'Nothing here can swap' })).toBeVisible()
})

test('an instruction it cannot read gets told what works, and nothing is built', async ({
  page,
}) => {
  await connectFakeSolanaWallet(page)
  let asked = false
  await page.route('**/api/chain/solana/prepare', async (route) => {
    asked = true
    await route.abort()
  })
  await say(page, 'swap all my USDC')
  await expect(page.getByRole('alert').filter({ hasText: 'swap 10 USDC to SOL' })).toBeVisible()
  expect(asked).toBe(false)
})

test('the apps page shows which apps run and which are only listed', async ({ page }) => {
  await connectFakeSolanaWallet(page)
  await page.getByRole('link', { name: 'Apps' }).first().click()
  await expect(page).toHaveURL(/\/solana\/apps$/, { timeout: 45_000 })
  await expect(page.getByText('Jupiter', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Kamino', { exact: false }).first()).toBeVisible()
  await expect(page.getByText('Works from chat').first()).toBeVisible()
  await expect(page.getByText('Agents trade here')).toHaveCount(0)
})
