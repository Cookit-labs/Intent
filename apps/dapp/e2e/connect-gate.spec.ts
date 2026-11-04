import { expect, test, type Page } from '@playwright/test'

/**
 * The connect page, with fake wallets announced the way real extensions do it:
 * the Wallet Standard for Solana and Sui, EIP-6963 for EVM. Nothing here signs or
 * reaches a chain.
 */
test.use({ storageState: { cookies: [], origins: [] } })

const SOLANA_ADDRESS = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg'
const SUI_ADDRESS = `0x${'ab'.repeat(32)}`
const EVM_ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7'

async function installFakeWallets(page: Page): Promise<void> {
  await page.addInitScript(
    ({ solana, sui, evm }) => {
      const icon =
        'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4='

      function standardWallet(name: string, chain: string, address: string): unknown {
        const account = { address, publicKey: new Uint8Array(32), chains: [chain], features: [] }
        return {
          version: '1.0.0',
          name,
          icon,
          chains: [chain],
          accounts: [account],
          features: {
            'standard:connect': {
              version: '1.0.0',
              connect: async () => {
                if (window.localStorage.getItem('fake-wallet-declines') === '1') {
                  throw new Error('User rejected the request.')
                }
                return { accounts: [account] }
              },
            },
            'standard:disconnect': { version: '1.0.0', disconnect: async () => undefined },
            'standard:events': { version: '1.0.0', on: () => () => undefined },
          },
        }
      }

      const wallets = [
        standardWallet('Fake Solana', 'solana:mainnet', solana),
        standardWallet('Fake Sui', 'sui:mainnet', sui),
      ]
      for (const wallet of wallets) {
        const register = (api: { register: (w: unknown) => void }): void => {
          api.register(wallet)
        }
        window.dispatchEvent(
          new CustomEvent('wallet-standard:register-wallet', { detail: register })
        )
        window.addEventListener('wallet-standard:app-ready', (e) => {
          register((e as CustomEvent).detail)
        })
      }

      let chainId = '0x1'
      const provider = {
        on: () => undefined,
        removeListener: () => undefined,
        request: async ({ method, params }: { method: string; params?: { chainId: string }[] }) => {
          switch (method) {
            // Like a real wallet: no accounts until the site has been approved.
            case 'eth_requestAccounts':
              window.localStorage.setItem('fake-evm-approved', '1')
              return [evm]
            case 'eth_accounts':
              return window.localStorage.getItem('fake-evm-approved') === '1' ? [evm] : []
            case 'eth_chainId':
              return chainId
            case 'wallet_switchEthereumChain':
              chainId = params?.[0]?.chainId ?? chainId
              return null
            default:
              return null
          }
        },
      }
      const announce = (): void => {
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', {
            detail: {
              info: { uuid: 'fake-evm', name: 'Fake EVM', icon, rdns: 'xyz.fake.evm' },
              provider,
            },
          })
        )
      }
      window.addEventListener('eip6963:requestProvider', announce)
      announce()
    },
    { solana: SOLANA_ADDRESS, sui: SUI_ADDRESS, evm: EVM_ADDRESS }
  )
}

const connectButton = (page: Page) => page.getByRole('button', { name: 'Connect wallet' })
const dialog = (page: Page) => page.locator('[data-connect-steps]')
const appNav = (page: Page) => page.getByRole('link', { name: 'History' })

test.beforeEach(async ({ page }) => {
  await installFakeWallets(page)
})

test('the root shows the connect page, with no chain in the address', async ({ page }) => {
  await page.goto('/')
  await expect(connectButton(page)).toBeVisible()
  await expect(appNav(page)).toHaveCount(0)
  expect(new URL(page.url()).pathname).toBe('/')
})

test('a chain screen without a wallet goes to the connect page', async ({ page }) => {
  await page.goto('/near/intents')
  await expect(connectButton(page)).toBeVisible()
  await expect(appNav(page)).toHaveCount(0)
  expect(new URL(page.url()).pathname).toBe('/')
})

test('picking a chain puts it in the address, and every screen keeps it', async ({ page }) => {
  await page.goto('/')
  await connectButton(page).click()
  await dialog(page).getByRole('button', { name: 'Solana' }).click()
  await dialog(page).getByRole('button', { name: 'Fake Solana' }).click()
  await expect(page).toHaveURL(/\/solana\/intents$/)

  await page.getByRole('link', { name: 'Agents' }).first().click()
  await expect(page).toHaveURL(/\/solana\/agents$/, { timeout: 45_000 })
})

test('the picker offers the six chains, and not Arc', async ({ page }) => {
  await page.goto('/stellar/intents')
  await connectButton(page).click()
  const chains = dialog(page).getByRole('button')
  for (const name of ['Stellar', 'Solana', 'Avalanche', 'Sui', 'Monad', 'NEAR']) {
    await expect(chains.filter({ hasText: new RegExp(`^${name}$`) })).toBeVisible()
  }
  await expect(chains.filter({ hasText: 'Arc' })).toHaveCount(0)
})

test('each chain lists its own wallets, ready ones first', async ({ page }) => {
  await page.goto('/stellar/intents')
  await connectButton(page).click()

  await dialog(page).getByRole('button', { name: 'Solana' }).click()
  await expect(dialog(page).getByRole('button', { name: 'Fake Solana' })).toBeVisible()
  await expect(dialog(page).getByRole('link', { name: /Phantom/ })).toHaveAttribute(
    'href',
    'https://phantom.com/download'
  )
  await expect(dialog(page).getByText('Fake Sui')).toHaveCount(0)

  await page.getByRole('button', { name: 'Choose another chain' }).click()
  await dialog(page).getByRole('button', { name: 'Sui' }).click()
  await expect(dialog(page).getByRole('button', { name: 'Fake Sui' })).toBeVisible()
  await expect(dialog(page).getByText('Fake Solana')).toHaveCount(0)

  await page.getByRole('button', { name: 'Choose another chain' }).click()
  await dialog(page).getByRole('button', { name: 'Avalanche' }).click()
  await expect(dialog(page).getByRole('button', { name: 'Fake EVM' })).toBeVisible()

  await page.getByRole('button', { name: 'Choose another chain' }).click()
  await dialog(page).getByRole('button', { name: 'Stellar' }).click()
  await expect(dialog(page).getByText('Freighter')).toBeVisible()
})

test('NEAR lists wallets from its manifest', async ({ page }) => {
  await page.goto('/stellar/intents')
  await connectButton(page).click()
  await dialog(page).getByRole('button', { name: 'NEAR' }).click()
  await expect(dialog(page).getByRole('button', { name: /Meteor/ })).toBeVisible({
    timeout: 20_000,
  })
})

test('connecting opens the app on that chain, on the page that was asked for', async ({ page }) => {
  await page.goto('/stellar/history')
  await connectButton(page).click()
  await dialog(page).getByRole('button', { name: 'Solana' }).click()
  await dialog(page).getByRole('button', { name: 'Fake Solana' }).click()

  await expect(page).toHaveURL(/\/solana\/history$/)
  await expect(appNav(page)).toBeVisible()
  await expect(page.getByRole('button', { name: /^Wallet vines1/ })).toBeVisible()
})

test('a returning visitor goes straight back in', async ({ page }) => {
  await page.goto('/sui/intents')
  await connectButton(page).click()
  await dialog(page).getByRole('button', { name: 'Sui' }).click()
  await dialog(page).getByRole('button', { name: 'Fake Sui' }).click()
  await expect(appNav(page)).toBeVisible()

  await page.reload()
  await expect(appNav(page)).toBeVisible()
  await expect(connectButton(page)).toHaveCount(0)

  await page.goto('/')
  await expect(page).toHaveURL(/\/sui\/intents$/)
  await expect(appNav(page)).toBeVisible()
})

test('disconnecting goes back to the connect page', async ({ page }) => {
  await page.goto('/solana/intents')
  await connectButton(page).click()
  await dialog(page).getByRole('button', { name: 'Solana' }).click()
  await dialog(page).getByRole('button', { name: 'Fake Solana' }).click()
  await page.getByRole('button', { name: /^Wallet vines1/ }).click()
  await page.getByRole('button', { name: 'Disconnect' }).click()

  await expect(connectButton(page)).toBeVisible()
  await expect(appNav(page)).toHaveCount(0)
  await expect(page).toHaveURL(/\/$/)

  await page.reload()
  await expect(connectButton(page)).toBeVisible()
})

test('declining in the wallet stays on the list, with no error', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('fake-wallet-declines', '1'))
  await page.goto('/stellar/intents')
  await connectButton(page).click()
  await dialog(page).getByRole('button', { name: 'Solana' }).click()
  await dialog(page).getByRole('button', { name: 'Fake Solana' }).click()

  await expect(dialog(page).getByRole('button', { name: 'Fake Solana' })).toBeEnabled()
  await expect(dialog(page).getByRole('alert')).toHaveCount(0)
  await expect(appNav(page)).toHaveCount(0)
})

test('an EVM wallet is asked onto the chain that was picked', async ({ page }) => {
  await page.goto('/stellar/intents')
  await connectButton(page).click()
  await dialog(page).getByRole('button', { name: 'Avalanche' }).click()
  await dialog(page).getByRole('button', { name: 'Fake EVM' }).click()

  await expect(page).toHaveURL(/\/avalanche\/intents$/)
  await expect(appNav(page)).toBeVisible()
  await expect(page.getByText('Wrong network')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Wallet 0x5290/ })).toBeVisible()
})

test('the switcher asks for a wallet on a chain that has none, in place', async ({ page }) => {
  await page.goto('/solana/intents')
  await connectButton(page).click()
  await dialog(page).getByRole('button', { name: 'Solana' }).click()
  await dialog(page).getByRole('button', { name: 'Fake Solana' }).click()
  await expect(appNav(page)).toBeVisible()

  await page.getByRole('button', { name: /Switch chain/ }).click()
  await page.getByRole('menuitem', { name: /Sui mainnet/ }).click()
  await expect(dialog(page).getByRole('heading', { name: 'Connect to Sui' })).toBeVisible()
  await expect(page).toHaveURL(/\/solana\/intents$/)

  await dialog(page).getByRole('button', { name: 'Fake Sui' }).click()
  await expect(page).toHaveURL(/\/sui\/intents$/)

  await page.getByRole('button', { name: /Switch chain/ }).click()
  await page.getByRole('menuitem', { name: /Solana mainnet/ }).click()
  await expect(page).toHaveURL(/\/solana\/intents$/)
  await expect(dialog(page)).toHaveCount(0)
})

test('the mobile layout keeps the steps in view, without the slides', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await page.goto('/stellar/intents')
  await connectButton(page).click()
  await expect(dialog(page)).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('complementary', { name: 'What Intent does' })).toHaveCount(0)
})

test('the slides move on by themselves, and can be paused and chosen', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/stellar/intents')
  const panel = page.getByRole('complementary', { name: 'What Intent does' })
  await expect(panel.getByRole('heading', { name: 'Say what you want' })).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'Agents compete for your trade' })).toBeVisible({
    timeout: 12_000,
  })

  await panel.getByRole('button', { name: 'Pause slides' }).click()
  await panel.getByRole('button', { name: /^Show slide 4/ }).click()
  await expect(panel.getByRole('heading', { name: 'Cash out to naira' })).toBeVisible()
  await page.waitForTimeout(8_000)
  await expect(panel.getByRole('heading', { name: 'Cash out to naira' })).toBeVisible()
})

test('going back from the chain step returns to the connect button', async ({ page }) => {
  await page.goto('/stellar/intents')
  await connectButton(page).click()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(connectButton(page)).toBeVisible()
})
