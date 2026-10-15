import { expect, test } from '@playwright/test'

const INTENT = 'swap $20 of USDC to XLM'

/**
 * One intent, submitted with nothing behind it: no wallet, no model key.
 *
 * With no model key the orchestrator answers "not configured" and the chat
 * says it cannot read the message right now; there is deliberately no keyword
 * fallback. With a key, the compete route answers that the agents are offline
 * when no provider has one. Each is a state the app renders on purpose, so the
 * assertion is on the furthest of those states the page reaches — a proposal
 * to review, the connect-wallet refusal, the not-online card, or the cannot-read
 * message — and on the page never throwing on the way there.
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
  const unreadable = page.getByText(/can't read that right now/)
  await expect(review.or(connect).or(offline).or(unreadable).first()).toBeVisible({
    timeout: 45_000,
  })

  // React's production fallback for a render that threw.
  await expect(page.getByText('Application error')).toHaveCount(0)
  expect(pageErrors).toEqual([])
})
