import { expect, test } from '@playwright/test'

/** History belongs to a wallet, and the suite never connects one. */
test('the stellar history page asks for a wallet when none is connected', async ({ page }) => {
  await page.goto('/stellar/history')

  await expect(page.getByRole('heading', { name: 'History', exact: true })).toBeVisible()
  await expect(page.getByText('Connect a wallet to see its history.')).toBeVisible()
})
