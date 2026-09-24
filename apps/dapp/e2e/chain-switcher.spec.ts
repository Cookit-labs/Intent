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

  for (const chain of ['Arc', 'Stellar']) {
    const item = menu.getByRole('menuitem', { name: new RegExp(`^${chain}\\b`) })
    await expect(item).toHaveCount(1)
    await expect(item).toBeEnabled()
  }

  for (const chain of ['Solana', 'Avalanche']) {
    const item = menu.getByRole('menuitem', { name: new RegExp(`^${chain}\\b`) })
    await expect(item).toHaveCount(1)
    await expect(item).toContainText('Coming soon')
    await expect(item).toHaveAttribute('aria-disabled', 'true')
  }
})
