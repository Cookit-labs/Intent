import { describe, expect, it } from 'vitest'

import { deliveredFromResultXdr } from '../swap/delivered'

/**
 * Reading what a settled swap actually delivered.
 *
 * The figure a sequence signs its second step against. Every alternative to
 * reading it out of the result is an estimate: the quote was taken before
 * execution, and a path payment fills against whatever liquidity existed at the
 * moment it ran.
 *
 * The XDR below is genuine, produced by encoding a path payment result with the
 * SDK rather than written by hand. That matters — the failure this guards
 * against is reading the wrong field out of a real structure, which a
 * hand-written fixture shaped to match the reader could never catch.
 */

/**
 * A settled `pathPaymentStrictSend` with one claim atom.
 *
 * Deliberately built so the two candidate figures differ: the atom bought
 * 4242424, and the destination received 7777777. A reader taking the atom's
 * amount would look correct on any transaction where they happen to agree.
 */
const STRICT_SEND_RESULT =
  'AAAAAAAAAGQAAAAAAAAAAQAAAAAAAAANAAAAAAAAAAEAAAABAAAAAHGwE9oV+txDRbTgnWhnL5D9MRAkXnPDanRcmH2LIjkJAAAAAAAAMDkAAAAAAAAAAACWtD8AAAAAAAAAAABAu/gAAAAAcbAT2hX63ENFtOCdaGcvkP0xECRec8NqdFyYfYsiOQkAAAAAAAAAAAB2rfEAAAAA'

describe('reading the delivered amount', () => {
  it('reads what reached the destination', () => {
    expect(deliveredFromResultXdr(STRICT_SEND_RESULT)).toBe('7777777')
  })

  it('does not report what an intermediate offer bought', () => {
    // A swap routed through several offers has several atoms, and only the
    // final delivery is what the account can then supply. Reading an atom
    // would overstate on some routes and understate on others.
    expect(deliveredFromResultXdr(STRICT_SEND_RESULT)).not.toBe('4242424')
  })

  it('returns nothing for input that is not a transaction result', () => {
    // Nothing is the honest answer, and the caller is required to stop rather
    // than guess an amount.
    expect(deliveredFromResultXdr('not base64 xdr at all')).toBeUndefined()
  })

  it('returns nothing for an empty string', () => {
    expect(deliveredFromResultXdr('')).toBeUndefined()
  })

  it('returns nothing rather than throwing on well-formed but unrelated XDR', () => {
    // Horizon can return a result for a transaction that delivered nothing.
    // Throwing here would turn a normal outcome into a crash.
    expect(() => deliveredFromResultXdr('AAAAAAAAAGQAAAAAAAAAAA==')).not.toThrow()
  })
})
