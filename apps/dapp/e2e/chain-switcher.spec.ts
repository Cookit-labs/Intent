import { expect, test } from '@playwright/test'

/**
 * The switcher lists the two chains the app runs on and the two it plans to,
 * and the planned ones are visibly not selectable.
 *
 * Items are found by accessible name ("Arc Arc testnet", "Solana Coming
 * soon"): the name is what a screen reader gets, and the raw text content
 * runs the two spans together with no space to anchor on.
 */
test('the chain switcher lists arc and stellar, with solana and avalanche coming soon', async ({
  page,
}) => {
  await page.goto('/arc/intents')

  await page.getByRole('button', { name: /^Chain: / }).click()
  const menu = page.getByRole('menu', { name: 'Choose a chain' })
  await expect(menu).toBeVisible()

  const arc = menu.getByRole('menuitem', { name: /^Arc\b/ })
  await expect(arc).toHaveCount(1)
  await expect(arc).toBeEnabled()

  // Stellar appears for the network this server runs on, and again for the
  // other network: a link when another deployment is configured, otherwise a
  // disabled row that says it is not set up here.
  const active = menu.getByRole('menuitem', { name: /^Stellar Stellar testnet$/ })
  await expect(active).toHaveCount(1)
  await expect(active).toBeEnabled()
  const other = menu.getByRole('menuitem', { name: /^Stellar Stellar mainnet/ })
  await expect(other).toHaveCount(1)
  await expect(other).toHaveAttribute('aria-disabled', 'true')

  for (const chain of ['Solana', 'Avalanche']) {
    const item = menu.getByRole('menuitem', { name: new RegExp(`^${chain}\\b`) })
    await expect(item).toHaveCount(1)
    await expect(item).toContainText('Coming soon')
    await expect(item).toHaveAttribute('aria-disabled', 'true')
  }
})
