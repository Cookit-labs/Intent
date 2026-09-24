import { expect, test } from '@playwright/test'

const INTENT = 'swap $20 of USDC to XLM'

/**
 * One intent, submitted with nothing behind it: no wallet, no model key.
 *
 * The parse route answers "not configured" and the regex reading takes over;
 * the compete route answers that the agents are offline because no provider
 * has a key. Each is a state the app renders on purpose, so the assertion is
 * on the furthest of those states the page reaches — a proposal to review,
 * the connect-wallet refusal, or the not-online card — and on the page never
 * throwing on the way there.
 */
test('composing a swap without a wallet reaches a rendered outcome, not an error', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('/stellar/intents')

  await page.getByRole('textbox', { name: 'Describe your intent' }).fill(INTENT)
  await page.getByRole('button', { name: 'Send intent' }).click()

  // The sentence is echoed into the thread the moment it is accepted.
  await expect(page.getByText(INTENT, { exact: true })).toBeVisible()

  const review = page.getByRole('button', { name: 'Review' })
  const connect = page.getByText(/Connect a wallet/)
  const offline = page.getByText('Agents are not online', { exact: true })
  await expect(review.or(connect).or(offline).first()).toBeVisible({ timeout: 45_000 })

  // React's production fallback for a render that threw.
  await expect(page.getByText('Application error')).toHaveCount(0)
  expect(pageErrors).toEqual([])
})
