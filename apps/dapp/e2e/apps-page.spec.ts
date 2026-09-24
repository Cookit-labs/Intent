import { expect, test } from '@playwright/test'

/** Each venue card is one link; the badges inside it say what the app can do there. */
test('the stellar apps page shows soroswap as integrated and soroban domains under names', async ({
  page,
}) => {
  await page.goto('/stellar/apps')

  await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible()

  // Exact, so "Soroswap Aggregator" is a different card.
  const soroswap = page.locator('a').filter({ has: page.getByText('Soroswap', { exact: true }) })
  await expect(soroswap).toHaveCount(1)
  await expect(soroswap.getByText('Integrated', { exact: true })).toBeVisible()

  const domains = page
    .locator('a')
    .filter({ has: page.getByText('Soroban Domains', { exact: true }) })
  await expect(domains).toHaveCount(1)
  await expect(domains.getByText('Names', { exact: true })).toBeVisible()
})
