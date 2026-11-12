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
  if (SHOTS === undefined) return
  // Every logo loaded and faded in, so a frame never catches one half-drawn.
  await page.waitForFunction(() => [...document.images].every((img) => img.complete))
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
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

const ROW = 'Manage supplied USDC on Kamino Lend'

test.describe('an open position on History', () => {
  test('shows the venue it is at, never another chain’s', async ({ page }) => {
    await stubPosition(page)
    await connect(page)
    await openHistory(page)

    await expect(page.getByRole('button', { name: ROW })).toBeVisible()
    await expect(page.getByText('12.5', { exact: true }).first()).toBeVisible()
    await expect(page.getByText(/Blend/)).toHaveCount(0)
    await expect(page.getByText('Deposit on Kamino Lend')).toBeVisible()
    await expect(page.getByText(/Compose your first intent/)).toHaveCount(0)
    await shot(page, 'history-closed')
  })

  test('withdraws all of it, from the panel, through to the wallet', async ({ page }) => {
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

    await page.getByRole('button', { name: ROW }).click()
    const panel = page.getByRole('dialog', { name: 'Kamino Lend position' })
    await expect(panel).toBeVisible()
    await shot(page, 'history-manage')
    await panel.getByRole('button', { name: 'Max' }).click()
    await panel.getByRole('button', { name: 'Withdraw all' }).click()

    await expect(panel.getByText('Built withdraw of all USDC on Kamino Lend.')).toBeVisible()
    expect(prepared()[0]).toEqual({
      account: ADDRESS,
      request: { kind: 'withdraw', amount: 'all', tokenIn: 'USDC', venue: 'Kamino Lend' },
    })
    await shot(page, 'history-review')

    await panel.getByRole('button', { name: 'Sign and send' }).click()
    await expect(panel.getByRole('link', { name: /abc123/ })).toBeVisible()
    expect(submitted).toMatchObject({
      account: ADDRESS,
      venueId: 'kamino-lend',
      signed: { family: 'solana', signedTransaction: SIGNED },
    })
  })

  test('withdraws an amount typed or a share, and refuses more than is there', async ({ page }) => {
    const { prepared } = await stubPosition(page)
    await connect(page)
    await openHistory(page)
    await page.getByRole('button', { name: ROW }).click()
    const panel = page.getByRole('dialog', { name: 'Kamino Lend position' })

    const amount = panel.getByRole('textbox', { name: 'Amount of USDC to withdraw' })
    await amount.fill('99')
    await expect(panel.getByRole('button', { name: 'More than you have' })).toBeDisabled()

    await panel.getByRole('button', { name: '50%' }).click()
    await expect(amount).toHaveValue('6.25')

    await amount.fill('2.5')
    await panel.getByRole('button', { name: 'Withdraw 2.5 USDC' }).click()
    await expect(panel.getByText('Built withdraw of 2.5 USDC on Kamino Lend.')).toBeVisible()
    expect(prepared()[0]).toEqual({
      account: ADDRESS,
      request: { kind: 'withdraw', amount: '2.5', tokenIn: 'USDC', venue: 'kamino-lend' },
    })

    await panel.getByRole('button', { name: 'Change amount' }).click()
    await expect(amount).toBeVisible()
  })

  test('tops up with an amount typed, with no limit from the position', async ({ page }) => {
    const { prepared } = await stubPosition(page)
    await connect(page)
    await openHistory(page)
    await page.getByRole('button', { name: ROW }).click()
    const panel = page.getByRole('dialog', { name: 'Kamino Lend position' })

    await panel.getByRole('tab', { name: 'Top up' }).click()
    await expect(panel.getByRole('button', { name: 'Max' })).toHaveCount(0)
    await panel.getByRole('textbox', { name: 'Amount of USDC to top up' }).fill('50')
    await shot(page, 'history-topup')
    await panel.getByRole('button', { name: 'Top up 50 USDC' }).click()

    await expect(panel.getByText('Built supply of 50 USDC on Kamino Lend.')).toBeVisible()
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
    await expect(page.getByRole('button', { name: ROW })).toBeVisible()
    await shot(page, 'chat-positions')
    await page.getByRole('button', { name: ROW }).click()
    const panel = page.getByRole('dialog', { name: 'Kamino Lend position' })
    await panel.getByRole('button', { name: 'Max' }).click()
    await panel.getByRole('button', { name: 'Withdraw all' }).click()
    await expect(panel.getByText('Built withdraw of all USDC on Kamino Lend.')).toBeVisible()
    expect(prepared()).toHaveLength(1)
  })

  test('open ready to use when asked to withdraw from one', async ({ page }) => {
    await stubPosition(page)
    await connect(page)

    await say(page, 'withdraw from kamino lend')
    const panel = page.getByRole('dialog', { name: 'Kamino Lend position' })
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Max' })).toBeVisible()
    await shot(page, 'chat-position-open')
  })

  test('stay answered in the chat after the next message, and so do tokens', async ({ page }) => {
    await stubPosition(page)
    await stubTokens(page)
    await connect(page)

    await say(page, 'do i have any open positions?')
    await expect(page.getByRole('button', { name: ROW })).toBeVisible()
    await say(page, 'give me a list of tokens on this chain')
    await expect(page.getByText('Tokens on Solana', { exact: true })).toBeVisible()
    await expect(page.getByText(/Here's what I can read on Solana/)).toBeVisible()
    await expect(page.getByText(/12\.5 USDC/).first()).toBeVisible()

    await say(page, 'show my positions')
    await expect(page.getByRole('button', { name: ROW })).toBeVisible()
    await expect(page.getByText(/^Tokens on Solana:/)).toBeVisible()
    await shot(page, 'chat-cards-kept')
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
    await expect(page.getByText('dogwifhat')).toBeVisible()
    await expect(page.getByText('$378M')).toBeVisible()
    await expect(page.getByText('5.25M')).toBeVisible()
    // A token using a known name gets no borrowed logo: the real one draws once, for the real one.
    await expect(page.locator('ul img[src*="usdc"]')).toHaveCount(1)
    await shot(page, 'tokens-stubbed')

    await page.getByRole('button', { name: /^Verified/ }).click()
    await expect(page.getByText('Totally USDC')).toHaveCount(0)
    await page.getByRole('button', { name: /^All/ }).click()

    await page.getByRole('button', { name: 'WIF details' }).click()
    const panel = page.getByRole('dialog', { name: 'WIF' })
    await expect(panel.getByText('Jupiter', { exact: true })).toBeVisible()
    await expect(panel.getByText('WIF/SOL')).toBeVisible()
    await expect(panel.getByRole('link', { name: 'View on explorer' })).toHaveAttribute(
      'href',
      'https://solscan.io/token/WIF'
    )
    await shot(page, 'tokens-detail')
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'USDC details' }).last().click()
    const fake = page.getByRole('dialog', { name: 'USDC' })
    await expect(fake.getByText('Not verified by anyone here')).toBeVisible()
    await expect(fake.getByText(/Not the USDC this app trades/)).toBeVisible()
    await page.keyboard.press('Escape')

    await page.getByRole('textbox', { name: 'Search tokens on Solana' }).fill('wif')
    await expect(page.getByText('USD Coin')).toHaveCount(0)
    await expect(page.getByText('dogwifhat')).toBeVisible()
  })

  test('list in the chat when asked, with their logos', async ({ page }) => {
    await stubTokens(page)
    await connect(page)

    await say(page, 'give me a list of tokens on this chain')
    await expect(page.getByText('Tokens on Solana', { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'All tokens on Solana' })).toBeVisible()
    const logo = page.locator('img[src*="usdc"]').first()
    await expect
      .poll(() => logo.evaluate((img) => (img as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0)
    await expect(logo).toHaveCSS('opacity', '1')
    await shot(page, 'chat-token-list')
  })

  test('answer about one token in the chat, the real one before its namesake', async ({ page }) => {
    await stubTokens(page)
    await connect(page)

    await say(page, 'is USDC verified')
    await expect(page.getByText('Jupiter', { exact: true })).toBeVisible()
    await expect(page.getByText('Tradable on Intent', { exact: true })).toBeVisible()
    await expect(page.getByText(/Another token uses this name/)).toBeVisible()
    await shot(page, 'chat-token-one')
  })
})
