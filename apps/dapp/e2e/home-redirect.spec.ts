import { expect, test } from '@playwright/test'

/**
 * The bare root has no page of its own: `next.config.js` redirects it to the
 * default chain's intents page, and that page's composer is the first thing
 * anyone sees.
 */
test('the root redirects to the default chain, arc, and the composer renders', async ({ page }) => {
  await page.goto('/')

  // The default chain is a decision, not an accident: a regression that sent
  // the root to Stellar would still be "a chain intents page".
  await expect(page).toHaveURL(/\/arc\/intents$/)
  await expect(page.getByRole('heading', { name: 'Intents', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Describe your intent' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send intent' })).toBeVisible()
})
