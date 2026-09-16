import { describe, expect, it } from 'vitest'

import { explainPoolError, isTransientPoolError, poolErrorCode } from '../lend/pool-errors'

/**
 * Turning `Error(Contract, #1205)` into something a person can act on.
 *
 * The two cases that matter pull in opposite directions: a known code must be
 * translated, and an unknown one must not be. Guessing at an unfamiliar
 * failure would send someone chasing a problem they do not have while hiding
 * the one they do.
 */

const REAL_1217 =
  'HostError: Error(Contract, #1217)\n\nEvent log (newest first):\n   0: [Diagnostic Event] contract:CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF, topics:[error, Error(Contract, #1217)]'

describe('reading the code out of a host error', () => {
  it('finds it in the real thing', () => {
    expect(poolErrorCode(REAL_1217)).toBe(1217)
  })

  it('is undefined when there is no code', () => {
    expect(poolErrorCode('Simulation failed.')).toBeUndefined()
  })

  it('is undefined for a non-contract host error', () => {
    expect(poolErrorCode('HostError: Error(WasmVm, InvalidAction)')).toBeUndefined()
  })
})

describe('the codes this app can actually provoke', () => {
  it('explains an empty position, confirmed live', () => {
    // Reclaiming collateral that was never posted returns this.
    expect(explainPoolError(REAL_1217)).toMatch(/nothing supplied/i)
  })

  it('explains a full reserve, confirmed live', () => {
    // wBTC sat at 94.30% against a 95% ceiling while this was written, so a
    // sound borrow is refused for reasons that are nothing to do with the
    // borrower. Saying "InvalidUtilRate" to them would be indefensible.
    const explained = explainPoolError('HostError: Error(Contract, #1207)')

    expect(explained).toMatch(/lent out too much/i)
    expect(explained).not.toMatch(/1207|InvalidUtilRate/)
  })

  it('explains insufficient collateral', () => {
    expect(explainPoolError('HostError: Error(Contract, #1205)')).toMatch(/collateral/i)
  })

  it('explains nothing borrowed to repay', () => {
    expect(explainPoolError('HostError: Error(Contract, #1219)')).toMatch(/nothing borrowed/i)
  })
})

describe('an unknown failure is passed through untouched', () => {
  it('keeps a code the table has never seen', () => {
    const raw = 'HostError: Error(Contract, #9999)'
    expect(explainPoolError(raw)).toBe(raw)
  })

  it('keeps a message that is not a contract error at all', () => {
    expect(explainPoolError('The transaction could not be read.')).toBe(
      'The transaction could not be read.'
    )
  })
})

describe('whether waiting could help', () => {
  it('says a full reserve may clear', () => {
    expect(isTransientPoolError('HostError: Error(Contract, #1207)')).toBe(true)
  })

  it('says an empty position will not fix itself', () => {
    expect(isTransientPoolError(REAL_1217)).toBe(false)
  })

  it('does not promise that an unknown failure is retryable', () => {
    expect(isTransientPoolError('HostError: Error(Contract, #9999)')).toBe(false)
  })
})
