import { describe, expect, it } from 'vitest'

import { sequenceSubmitEndpoint } from '../swap/sequence-endpoint'

const none = {
  isNairaStep: false,
  isSendStep: false,
  isOfframpStep: false,
  isDefindexStep: false,
}

describe('sequenceSubmitEndpoint', () => {
  it('sends the first step of a sequence to the swap endpoint, which knows every route', () => {
    expect(sequenceSubmitEndpoint({ ...none, stepIndex: 0 })).toBe('/api/swap/submit')
  })

  it('never sends a swap step to the plan endpoint, which refuses a router call', () => {
    for (const stepIndex of [0, 1, 2]) {
      expect(sequenceSubmitEndpoint({ ...none, stepIndex })).not.toBe('/api/plan/submit')
    }
  })

  it('sends the supply step to the lending endpoint, or DeFindex’s', () => {
    expect(sequenceSubmitEndpoint({ ...none, stepIndex: 1 })).toBe('/api/lend/submit')
    expect(sequenceSubmitEndpoint({ ...none, stepIndex: 1, isDefindexStep: true })).toBe(
      '/api/lend/defindex/submit'
    )
  })

  it('sends a payment to the send endpoint and a withdrawal to the offramp one', () => {
    expect(sequenceSubmitEndpoint({ ...none, stepIndex: 1, isSendStep: true })).toBe(
      '/api/send/submit'
    )
    expect(sequenceSubmitEndpoint({ ...none, stepIndex: 1, isOfframpStep: true })).toBe(
      '/api/offramp/submit'
    )
  })

  it('sends the payout deposit to its own order', () => {
    expect(
      sequenceSubmitEndpoint({ ...none, stepIndex: 1, isNairaStep: true, orderId: 'ord-1' })
    ).toBe('/api/naira/orders/ord-1/submit')
  })

  it('keeps a single-step send or withdrawal off the swap endpoint', () => {
    expect(sequenceSubmitEndpoint({ ...none, stepIndex: 0, isSendStep: true })).toBe(
      '/api/send/submit'
    )
    expect(sequenceSubmitEndpoint({ ...none, stepIndex: 0, isOfframpStep: true })).toBe(
      '/api/offramp/submit'
    )
  })
})
