import { describe, expect, it } from 'vitest'

import { pinStatusLine, resolvedOnLabel, sendStepLabel, sentLabel } from '../send/labels'

/**
 * The sentences on the send card and in history.
 *
 * Pure text, kept out of the components so it can be pinned: the step label
 * before a payment runs, the label after it settled (which is what history
 * shows), where a name was resolved, and what the address book has to say.
 */

const G1 = 'GBGFEZ5QZFLQJTTCQUYWTJBGZN6QEVFF57F3LVD2MF7MRYWUNKFBJWIV'

describe('sendStepLabel', () => {
  it('names the amount, the asset and the recipient as typed', () => {
    expect(sendStepLabel('50', 'USDC', 'deon.xlm')).toBe('Send 50 USDC to deon.xlm')
  })

  it('drops the ledger’s trailing zeros', () => {
    expect(sendStepLabel('125.0000000', 'XLM', 'deon.xlm')).toBe('Send 125 XLM to deon.xlm')
    expect(sendStepLabel('12.5000000', 'USDC', 'deon.xlm')).toBe('Send 12.5 USDC to deon.xlm')
  })

  it('says "the result" before the swap has delivered anything', () => {
    expect(sendStepLabel(undefined, 'XLM', 'bob.xlm')).toBe('Send the XLM you receive to bob.xlm')
  })
})

describe('sentLabel', () => {
  it('is the settled form, for history', () => {
    expect(sentLabel('50', 'USDC', 'deon.xlm')).toBe('Sent 50 USDC to deon.xlm')
  })
})

describe('resolvedOnLabel', () => {
  it('says mainnet for a .xlm name', () => {
    expect(resolvedOnLabel({ kind: 'soroban-domain', resolvedOn: 'stellar-mainnet' })).toBe(
      'Name resolved on Stellar mainnet'
    )
  })

  it('names the federation domain', () => {
    expect(
      resolvedOnLabel({ kind: 'federation', resolvedOn: 'federation', input: 'alice*lobstr.co' })
    ).toBe('Resolved via federation at lobstr.co')
  })

  it('says nothing for a raw address', () => {
    expect(resolvedOnLabel({ kind: 'address' })).toBeUndefined()
  })
})

describe('pinStatusLine', () => {
  it('asks for a check on a first payment', () => {
    expect(pinStatusLine({ status: 'new' })).toBe('First payment to this name. Check the address.')
  })

  it('reassures on a repeat', () => {
    expect(pinStatusLine({ status: 'known' })).toBe('Same address as last time.')
  })

  it('names the previous address and when it was pinned on a change', () => {
    const line = pinStatusLine({
      status: 'changed',
      previous: G1,
      pinnedAt: '2026-09-01T10:00:00.000Z',
    })
    expect(line).toContain(G1)
    expect(line).toContain('2026-09-01')
    expect(line).toMatch(/somewhere new/)
  })
})
