import { describe, expect, it } from 'vitest'

import { classifyAnchorAnswer } from '../offramp/anchor-answer'

/**
 * What the browser does with the anchor route's answer.
 *
 * Two failures look alike from the outside and must be treated differently.
 * A 502 means the anchor could not be reached: said out loud, and the
 * sequence still prepared, because the build route refuses an out-of-range
 * withdrawal later. A 400 means the server refuses this anchor here at all —
 * on mainnet with no off-ramp configured, that is the whole answer — and
 * preparing a swap whose second half cannot happen would spend the user's
 * money on a promise the app already knows it cannot keep.
 */

describe('classifyAnchorAnswer', () => {
  it('passes limits through on success', () => {
    const limits = { enabled: true, feeEnabled: false, minAmount: 1 }
    expect(classifyAnchorAnswer(200, { limits })).toEqual({ kind: 'ok', limits })
    expect(classifyAnchorAnswer(200, { limits: null })).toEqual({ kind: 'ok' })
  })

  it('refuses on a 400, with the server’s reason', () => {
    expect(
      classifyAnchorAnswer(400, { error: 'no fiat off-ramp is configured on mainnet yet' })
    ).toEqual({ kind: 'refused', message: 'no fiat off-ramp is configured on mainnet yet' })
  })

  it('treats anything else as unreachable, keeping the reason when there is one', () => {
    expect(classifyAnchorAnswer(502, { error: 'TOML returned 503' })).toEqual({
      kind: 'unreachable',
      message: 'The anchor could not be reached: TOML returned 503',
    })
    expect(classifyAnchorAnswer(500, {})).toEqual({
      kind: 'unreachable',
      message: 'The anchor could not be reached: the request failed (500).',
    })
  })
})
