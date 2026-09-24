import { expect, test } from '@playwright/test'

/**
 * The bare root has no page of its own: `next.config.js` redirects it to the
 * default chain's intents page, and that page's composer is the first thing
 * anyone sees.
 */
test('the root redirects to a chain intents page and the composer renders', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveURL(/\/(arc|stellar)\/intents$/)
  await expect(page.getByRole('heading', { name: 'Intents', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Describe your intent' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send intent' })).toBeVisible()
})
