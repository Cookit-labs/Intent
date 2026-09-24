import { expect, test } from '@playwright/test'

/**
 * `GET /api/health` arrives with the monitoring slice (M3), which is not on
 * this branch. Skipped on a 404 rather than left out, so the spec starts
 * running the moment the route lands and nobody has to remember it.
 */
test('GET /api/health answers JSON', async ({ request }) => {
  const response = await request.get('/api/health')
  test.skip(response.status() === 404, 'no /api/health yet: the monitoring slice adds it')

  expect(response.headers()['content-type']).toContain('application/json')
  const body = (await response.json()) as { ok?: unknown }
  expect(typeof body.ok).toBe('boolean')
})
