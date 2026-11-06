import { expect, test } from '@playwright/test'

/**
 * A chain in beta says so in its switcher, and warns once on the way in. Stellar does neither. The
 * shared config marks the notice as seen so other specs aren't blocked, so this starts clean.
 */
test.use({
  storageState: {
    cookies: [
      {
        name: 'e2e-no-wallet-gate',
        value: '1',
        domain: 'localhost',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
      },
    ],
    origins: [],
  },
})

test('a beta chain warns once, and carries its tag', async ({ page }) => {
  await page.goto('/solana/intents')

  const notice = page.getByRole('alertdialog', { name: 'Solana is in beta' })
  // Long enough for a dev server's first compile of this page.
  await expect(notice).toBeVisible({ timeout: 45_000 })
  await expect(notice).toContainText('A transaction can fail')
  await expect(notice.getByRole('button', { name: 'I understand' })).toBeFocused()

  await notice.getByRole('button', { name: 'I understand' }).click()
  await expect(notice).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Chain: Solana.*, beta/ })).toContainText('Beta')

  // The dev server can abort a navigation while it recompiles.
  await expect(async () => {
    await page.reload()
  }).toPass()
  await expect(page.getByRole('button', { name: /^Chain: Solana/ })).toBeVisible()
  await expect(notice).toHaveCount(0)
})

test('each beta chain warns on its own', async ({ page }) => {
  await page.goto('/sui/intents')
  const sui = page.getByRole('alertdialog', { name: 'Sui is in beta' })
  await expect(sui).toBeVisible({ timeout: 45_000 })
  await page.keyboard.press('Escape')
  await expect(sui).toHaveCount(0)

  await page.goto('/near/intents')
  await expect(page.getByRole('alertdialog', { name: 'NEAR is in beta' })).toBeVisible()
})

test('Stellar has no notice and no tag', async ({ page }) => {
  await page.goto('/stellar/intents')
  const switcher = page.getByRole('button', { name: /^Chain: / })
  await expect(switcher).toBeVisible()
  await expect(switcher).not.toContainText('Beta')
  await expect(page.getByRole('alertdialog')).toHaveCount(0)

  await switcher.click()
  const menu = page.getByRole('menu', { name: 'Choose a chain' })
  await expect(menu.getByRole('menuitem', { name: /^Stellar/ })).not.toContainText('Beta')
  await expect(menu.getByRole('menuitem', { name: /^Monad/ })).toContainText('Beta')
})
