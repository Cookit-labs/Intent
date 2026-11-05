import { expect, test } from '@playwright/test'

/**
 * The switcher lists the chains a person can connect to, and Arc is not one of
 * them.
 *
 * Items are found by accessible name ("Solana mainnet"): the name is what a
 * screen reader gets, and the raw text content runs the two spans together with
 * no space to anchor on.
 */
test('the chain switcher lists the six connectable chains, and not Arc', async ({ page }) => {
  await page.goto('/stellar/intents')

  await page.getByRole('button', { name: /^Chain: / }).click()
  const menu = page.getByRole('menu', { name: 'Choose a chain' })
  await expect(menu).toBeVisible()

  await expect(menu.getByRole('menuitem', { name: /^Arc\b/ })).toHaveCount(0)

  // Stellar appears for the network this server runs on. The other network is
  // a link only when another deployment is configured, and this run has none.
  const active = menu.getByRole('menuitem', { name: /^Stellar testnet$/ })
  await expect(active).toHaveCount(1)
  await expect(active).toBeEnabled()
  await expect(menu.getByRole('menuitem', { name: /^Stellar mainnet/ })).toHaveCount(0)

  for (const chain of ['Solana', 'Avalanche', 'Sui', 'Monad', 'NEAR']) {
    const item = menu.getByRole('menuitem', { name: `${chain} mainnet` })
    await expect(item).toHaveCount(1)
    await expect(item).toBeEnabled()
    await expect(item).not.toHaveAttribute('aria-disabled', 'true')
  }
})
