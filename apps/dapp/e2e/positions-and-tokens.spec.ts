import { expect, test, type Page } from '@playwright/test'

import { BETA_NOTICE_SEEN } from './beta-notice-seen'

/**
 * Managing an open position and reading tokens, from a connected wallet, on the History page and in
 * the chat. A fake wallet announces itself the way a real one does, and the server routes are stubbed,
 * so nothing reaches a chain.
 */
test.use({ storageState: { cookies: [], origins: BETA_NOTICE_SEEN } })

const ADDRESS = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg'
const UNSIGNED = btoa('unsigned-transaction')
const SIGNED = btoa('signed-transaction')
const SHOTS = process.env['E2E_SHOTS']

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
}

async function connect(page: Page): Promise<void> {
  await page.addInitScript(
    ({ address, signed }) => {
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
            signTransaction: async () => [
              { signedTransaction: Uint8Array.from(atob(signed), (c) => c.charCodeAt(0)) },
            ],
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
    { address: ADDRESS, signed: SIGNED }
  )
  await page.goto('/solana/intents')
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  const steps = page.locator('[data-connect-steps]')
  await steps.getByRole('button', { name: 'Solana' }).click()
  await steps.getByRole('button', { name: 'Fake Solana' }).click()
  await expect(page.getByRole('textbox', { name: 'Describe your intent' })).toBeVisible({
    timeout: 90_000,
  })
}

async function say(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Describe your intent' }).fill(text)
  await page.getByRole('button', { name: 'Send intent' }).click()
}

async function openHistory(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'History' }).first().click()
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible({ timeout: 120_000 })
}

/** A position opened anywhere reads the same, since it is read from the venue. */
async function stubPosition(page: Page): Promise<{ prepared: () => unknown[] }> {
  const prepared: unknown[] = []
  await page.route('**/api/chain/solana/positions*', (route) =>
    route.fulfill({
      json: {
        venues: [
          {
            id: 'kamino-lend',
            name: 'Kamino Lend',
            kinds: ['supply', 'withdraw', 'borrow', 'repay'],
            positions: [{ slot: 'supplied', symbol: 'USDC', amount: '12.5' }],
          },
        ],
        unread: [],
      },
    })
  )
  await page.route('**/api/chain/solana/orders*', (route) =>
    route.fulfill({ json: { orders: [] } })
  )
  await page.route('**/api/chain/solana/activity*', (route) =>
    route.fulfill({
      json: {
        entries: [
          {
            hash: 'abc123',
            kind: 'lend',
            action: 'supply',
            venue: 'Kamino Lend',
            assetIn: 'USDC',
            assetOut: null,
            amountIn: '12.5',
            confirmed: true,
            at: '2026-11-07T10:00:00.000Z',
          },
        ],
      },
    })
  )
  await page.route('**/api/chain/solana/prepare', async (route) => {
    const body = route.request().postDataJSON() as { request: { kind: string; amount: string } }
    prepared.push(body)
    await route.fulfill({
      json: {
        prepared: {
          venueId: 'kamino-lend',
          venueName: 'Kamino Lend',
          kind: body.request.kind,
          summary: `Built ${body.request.kind} of ${body.request.amount} USDC on Kamino Lend.`,
          pay: { amount: '1', symbol: 'USDC' },
          notes: [],
          signing: { family: 'solana', transaction: UNSIGNED },
          context: { requestId: 'r1' },
        },
      },
    })
  })
  return { prepared: () => prepared }
}

const TOKENS = {
  partial: false,
  sources: ['Jupiter'],
  tokens: [
    {
      id: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      symbol: 'USDC',
      name: 'USD Coin',
      priceUsd: 1,
      change24h: 0.01,
      marketCapUsd: 8_600_000_000,
      fdvUsd: 8_600_000_000,
      liquidityUsd: 378_000_000,
      volume24hUsd: 1_080_000_000,
      holders: 5_248_202,
      verified: ['Checked by Intent, and tradable here', 'Verified by Jupiter'],
      listed: true,
      explorerUrl: 'https://solscan.io/token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    },
    {
      id: 'FAKEMINT',
      symbol: 'USDC',
      name: 'Totally USDC',
      priceUsd: 0.2,
      change24h: -40,
      liquidityUsd: 900,
      verified: [],
      listed: false,
      sameNameAs: 'USDC',
      explorerUrl: 'https://solscan.io/token/FAKEMINT',
    },
    {
      id: 'WIF',
      symbol: 'WIF',
      name: 'dogwifhat',
      priceUsd: 0.5,
      change24h: 3,
      marketCapUsd: 500_000_000,
      liquidityUsd: 12_000_000,
      volume24hUsd: 40_000_000,
      holders: 200_000,
      verified: ['Verified by Jupiter'],
      listed: false,
      explorerUrl: 'https://solscan.io/token/WIF',
    },
  ],
}

async function stubTokens(page: Page): Promise<void> {
  await page.route('**/api/chain/solana/tokens*', (route) => {
    const url = new URL(route.request().url())
    const id = url.searchParams.get('id')
    if (id !== null) {
      const token = TOKENS.tokens.find((t) => t.id === id)
      return route.fulfill({
        json: {
          token: {
            ...token,
            pools: [{ dex: 'orca', pair: `${token?.symbol}/SOL`, liquidityUsd: 2_000_000 }],
          },
        },
      })
    }
    const q = url.searchParams.get('q')?.toLowerCase()
    return route.fulfill({
      json:
        q === undefined
          ? TOKENS
          : { ...TOKENS, tokens: TOKENS.tokens.filter((t) => t.symbol.toLowerCase() === q) },
    })
  })
}

test.describe('an open position on History', () => {
  test('shows the venue it is at, never another chain’s', async ({ page }) => {
    await stubPosition(page)
    await connect(page)
    await openHistory(page)

    await expect(page.getByText('Supplied to Kamino Lend')).toBeVisible()
    await expect(page.getByText('12.5 USDC').first()).toBeVisible()
    await expect(page.getByText(/Blend/)).toHaveCount(0)
    await expect(page.getByText('Deposit on Kamino Lend')).toBeVisible()
    await expect(page.getByText(/Compose your first intent/)).toHaveCount(0)
    await shot(page, 'history-closed')
  })

  test('withdraws all of it, from the card, through to the wallet', async ({ page }) => {
    const { prepared } = await stubPosition(page)
    let submitted: unknown
    await page.route('**/api/chain/solana/submit', async (route) => {
      submitted = route.request().postDataJSON()
      await route.fulfill({
        json: { ok: true, hash: 'abc123def456', explorerUrl: 'https://solscan.io/tx/abc123def456' },
      })
    })
    await connect(page)
    await openHistory(page)

    await page.getByRole('button', { name: 'Manage' }).click()
    await shot(page, 'history-manage')
    await page.getByRole('button', { name: 'Withdraw all' }).click()

    await expect(page.getByText('Built withdraw of all USDC on Kamino Lend.')).toBeVisible()
    expect(prepared()[0]).toEqual({
      account: ADDRESS,
      request: { kind: 'withdraw', amount: 'all', tokenIn: 'USDC', venue: 'Kamino Lend' },
    })
    await shot(page, 'history-review')

    await page.getByRole('button', { name: 'Sign and send' }).click()
    await expect(page.getByRole('link', { name: /abc123/ })).toBeVisible()
    expect(submitted).toMatchObject({
      account: ADDRESS,
      venueId: 'kamino-lend',
      signed: { family: 'solana', signedTransaction: SIGNED },
    })
  })

  test('withdraws an amount typed, and refuses more than is there', async ({ page }) => {
    const { prepared } = await stubPosition(page)
    await connect(page)
    await openHistory(page)
    await page.getByRole('button', { name: 'Manage' }).click()

    const amount = page.getByRole('textbox', { name: 'Amount of USDC to withdraw' })
    await amount.fill('99')
    await expect(page.getByText('That is more than the 12.5 USDC here.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Withdraw', exact: true }).last()).toBeDisabled()

    await amount.fill('2.5')
    await page.getByRole('button', { name: 'Withdraw 2.5 USDC' }).click()
    await expect(page.getByText('Built withdraw of 2.5 USDC on Kamino Lend.')).toBeVisible()
    expect(prepared()[0]).toEqual({
      account: ADDRESS,
      request: { kind: 'withdraw', amount: '2.5', tokenIn: 'USDC', venue: 'kamino-lend' },
    })
  })

  test('tops up with an amount typed, with no limit from the position', async ({ page }) => {
    const { prepared } = await stubPosition(page)
    await connect(page)
    await openHistory(page)
    await page.getByRole('button', { name: 'Manage' }).click()

    await page.getByRole('button', { name: 'Top up' }).click()
    await expect(page.getByRole('button', { name: 'Withdraw all' })).toHaveCount(0)
    await page.getByRole('textbox', { name: 'Amount of USDC to top up' }).fill('50')
    await page.getByRole('button', { name: 'Top up 50 USDC' }).click()

    await expect(page.getByText('Built supply of 50 USDC on Kamino Lend.')).toBeVisible()
    expect(prepared()[0]).toEqual({
      account: ADDRESS,
      request: { kind: 'supply', amount: '50', tokenIn: 'USDC', venue: 'kamino-lend' },
    })
  })
})

test.describe('open positions in the chat', () => {
  test('come up when asked for, with the same way to manage them', async ({ page }) => {
    const { prepared } = await stubPosition(page)
    await connect(page)

    await say(page, 'show my positions')
    await expect(page.getByText('Supplied to Kamino Lend')).toBeVisible()
    await page.getByRole('button', { name: 'Manage' }).click()
    await page.getByRole('button', { name: 'Withdraw all' }).click()
    await expect(page.getByText('Built withdraw of all USDC on Kamino Lend.')).toBeVisible()
    expect(prepared()).toHaveLength(1)
    await shot(page, 'chat-position-review')
  })

  test('open ready to use when asked to withdraw from one', async ({ page }) => {
    await stubPosition(page)
    await connect(page)

    await say(page, 'withdraw from kamino lend')
    await expect(page.getByText('Supplied to Kamino Lend')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Withdraw all' })).toBeVisible()
    // The logo really draws in the thread, not only an empty frame while it loads.
    const logo = page.locator('img[src*="usdc"]').first()
    await expect(logo).toBeVisible()
    await expect
      .poll(() => logo.evaluate((img) => (img as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0)
    await shot(page, 'chat-position-open')
  })

  test('say so when nothing is open', async ({ page }) => {
    await page.route('**/api/chain/solana/positions*', (route) =>
      route.fulfill({ json: { venues: [], unread: [] } })
    )
    await page.route('**/api/chain/solana/orders*', (route) =>
      route.fulfill({ json: { orders: [] } })
    )
    await connect(page)

    await say(page, 'withdraw from my position')
    await expect(page.getByText(/You have nothing open on Solana/)).toBeVisible()
  })
})

test.describe('tokens', () => {
  test('list with their figures, search, filter and open', async ({ page }) => {
    await stubTokens(page)
    await connect(page)
    await page.getByRole('link', { name: 'Tokens' }).first().click()

    await expect(page.getByRole('heading', { name: 'Tokens' })).toBeVisible({ timeout: 120_000 })
    await expect(page.getByRole('cell', { name: /dogwifhat/ })).toBeVisible()
    await expect(page.getByRole('cell', { name: '$378M' })).toBeVisible()
    await expect(page.getByText('5.25M')).toBeVisible()
    await shot(page, 'tokens-stubbed')

    // A token using a known name gets no borrowed logo: the real one draws once, for the real one.
    await expect(page.locator('tbody img[src*="usdc"]')).toHaveCount(1)

    await page.getByRole('button', { name: 'Verified only' }).click()
    await expect(page.getByRole('cell', { name: /Totally USDC/ })).toHaveCount(0)
    await page.getByRole('button', { name: 'Verified only' }).click()

    await page.getByRole('button', { name: 'Show details for WIF' }).click()
    await expect(page.getByText('Verified by Jupiter').first()).toBeVisible()
    await expect(page.getByText('WIF/SOL on orca')).toBeVisible()
    await expect(page.getByRole('link', { name: 'View on explorer' })).toHaveAttribute(
      'href',
      'https://solscan.io/token/WIF'
    )
    await page.getByRole('button', { name: 'Hide details for WIF' }).click()

    await page.getByRole('button', { name: 'Show details for USDC' }).last().click()
    await expect(page.getByText(/Not verified by any source here/)).toBeVisible()
    await expect(page.getByText(/The USDC this app trades is a different token/)).toBeVisible()
    await page.getByRole('button', { name: 'Hide details for USDC' }).click()

    await page.getByRole('textbox', { name: 'Search tokens on Solana' }).fill('wif')
    await expect(page.getByRole('cell', { name: /USD Coin/ })).toHaveCount(0)
    await expect(page.getByRole('cell', { name: /dogwifhat/ })).toBeVisible()
  })

  test('list in the chat when asked', async ({ page }) => {
    await stubTokens(page)
    await connect(page)

    await say(page, 'give me a list of tokens on this chain')
    await expect(page.getByText('Tokens on Solana', { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'See all tokens on Solana' })).toBeVisible()
    await shot(page, 'chat-token-list')
  })

  test('answer about one token in the chat, the real one before its namesake', async ({ page }) => {
    await stubTokens(page)
    await connect(page)

    await say(page, 'is USDC verified')
    await expect(page.getByText('Verified by Jupiter')).toBeVisible()
    await expect(page.getByText('Checked by Intent, and tradable here')).toBeVisible()
    await expect(page.getByText('One other token uses this name', { exact: false })).toBeVisible()
    await shot(page, 'chat-token-one')
  })
})
