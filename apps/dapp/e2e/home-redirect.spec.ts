import { expect, test } from '@playwright/test'

/**
 * The bare root has no page of its own: middleware redirects it to the home
 * chain's intents page, and that page's composer is the first thing anyone sees.
 * This run serves one Stellar network, so home is the single `/stellar` address.
 * The two-network case, where home is Stellar mainnet, is in network-switch.spec.
 */
test('the root redirects to Stellar, the default chain, and the composer renders', async ({
  page,
}) => {
  await page.goto('/')

  // The default chain is a decision, not an accident: a regression that sent
  // the root back to Arc would still be "a chain intents page".
  await expect(page).toHaveURL(/\/stellar\/intents$/)
  await expect(page.getByRole('heading', { name: 'Intents', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Describe your intent' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send intent' })).toBeVisible()
})

test('an old unprefixed address opens the same screen on the default chain', async ({ page }) => {
  await page.goto('/apps')
  await expect(page).toHaveURL(/\/stellar\/apps$/)
})
