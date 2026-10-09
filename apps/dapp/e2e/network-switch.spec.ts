import { expect, test } from '@playwright/test'

/**
 * One server, both Stellar networks. Runs only when the server is started
 * serving both (`E2E_STELLAR_NETWORKS=testnet,mainnet`), because the default
 * run serves one and these pages do not exist there.
 */
test.skip(
  process.env['E2E_STELLAR_NETWORKS'] !== 'testnet,mainnet',
  'needs a server serving both networks: E2E_STELLAR_NETWORKS=testnet,mainnet'
)

test('the menu switches the page from testnet to mainnet and back', async ({ page }) => {
  await page.goto('/stellar-testnet/apps')
  await expect(page.locator('header')).toContainText('Stellar testnet')
  await expect(page.locator('header')).not.toContainText('Trades up to')

  await page.getByRole('button', { name: /^Chain: / }).click()
  await page.getByRole('menuitem', { name: /Stellar mainnet/ }).click()
  await page.waitForURL('**/stellar-mainnet/apps')
  await expect(page.locator('header')).toContainText('Stellar mainnet')
  await expect(page.locator('header')).toContainText('Trades up to')

  await page.getByRole('button', { name: /^Chain: / }).click()
  await page.getByRole('menuitem', { name: /Stellar testnet/ }).click()
  await page.waitForURL('**/stellar-testnet/apps')
  await expect(page.locator('header')).toContainText('Stellar testnet')
})

test('mainnet shows only the venues that are on mainnet, and testnet shows them all', async ({
  page,
}) => {
  await page.goto('/stellar-mainnet/apps')
  await expect(page.getByText('Not on mainnet yet').first()).toBeVisible()

  await page.goto('/stellar-testnet/apps')
  await expect(page.getByText('Not on mainnet yet')).toHaveCount(0)
})

test('the old /stellar address goes to the default network', async ({ page }) => {
  await page.goto('/stellar/apps')
  await page.waitForURL(/\/stellar-(testnet|mainnet)\/apps$/)
})

test('an API call is answered for the network it names, and an unknown one falls back', async ({
  request,
}) => {
  const mainnet = await request.get('/api/health?network=mainnet')
  expect((await mainnet.json()).network).toBe('mainnet')
  const testnet = await request.get('/api/health?network=testnet')
  expect((await testnet.json()).network).toBe('testnet')
  const unknown = await request.get('/api/health?network=pubnet')
  expect((await unknown.json()).network).toBe('testnet')
})

test('a request cannot reach mainnet pages by claiming testnet in a header', async ({
  request,
}) => {
  // The page address decides the network of a page, whatever a header says.
  const res = await request.get('/stellar-mainnet/apps', {
    headers: { 'x-intent-network': 'testnet' },
  })
  expect(res.status()).toBe(200)
  expect(await res.text()).toContain('Stellar mainnet')
})
