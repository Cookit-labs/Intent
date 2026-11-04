import { expect, test } from '@playwright/test'

/**
 * The bare root is the connect page, with no chain in the address: the chain goes
 * in once one is picked. See connect-gate.spec for that part.
 */
test('the root is the connect page, with no chain in the address', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/')
})

test('an old unprefixed address opens the same screen on the default chain', async ({ page }) => {
  await page.goto('/apps')
  await expect(page).toHaveURL(/\/stellar\/apps$/)
})
