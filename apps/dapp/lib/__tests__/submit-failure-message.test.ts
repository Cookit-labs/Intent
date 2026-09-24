import { describe, expect, it } from 'vitest'

import { FAILURE_MESSAGES, failureMessage } from '../swap/submit'

/**
 * What a step's failure says to the user.
 *
 * A submit route answers in one of two shapes: the network's refusal, with a
 * `reason` this table translates, or the route's own refusal, with an `error`
 * written for a person. The second was being dropped — a name that moved
 * between build and submit produced a sentence naming both addresses, and the
 * card showed "That step did not go through."
 */
describe('failureMessage', () => {
  it('translates a network reason', () => {
    expect(failureMessage({ reason: 'under_dest_min' })).toBe(FAILURE_MESSAGES.under_dest_min)
  })

  it('passes a route’s own refusal through', () => {
    expect(failureMessage({ error: 'refusing to sign send: destination — moved' })).toBe(
      'refusing to sign send: destination — moved'
    )
  })

  it('prefers the reason when both are present', () => {
    expect(failureMessage({ reason: 'expired', error: 'x' })).toBe(FAILURE_MESSAGES.expired)
  })

  it('falls back to a general sentence when neither is present', () => {
    expect(failureMessage({})).toBe('That step did not go through.')
  })
})
