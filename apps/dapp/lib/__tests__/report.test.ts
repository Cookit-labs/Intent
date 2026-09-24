import { describe, expect, it, vi } from 'vitest'

import { createReporter, redactContext, type ReportSink } from '../server/report'

/**
 * Error reporting: one line to the server log every time, and a copy to
 * Sentry when a DSN is configured.
 *
 * The property that matters is what never appears in either place. A route's
 * context is whatever the handler had to hand — the body, the account, the
 * signed envelope — and a log line that carried a signed XDR or a session
 * token would turn an operational aid into a leak. So redaction is keyed on
 * the name of the thing, not on recognising its value, and it is tested by
 * the names a route would actually use.
 */

describe('redactContext', () => {
  it('replaces values under secret-looking keys and masks emails', () => {
    const redacted = redactContext({
      signedXdr: 'AAAAAgAAAAB…',
      authToken: 'tok_123',
      secret: 'SB…',
      email: 'alice@test.com',
      account: 'GABC…',
      amount: '50',
    })

    expect(redacted).toEqual({
      signedXdr: '[redacted]',
      authToken: '[redacted]',
      secret: '[redacted]',
      email: 'a…@test.com',
      account: 'GABC…',
      amount: '50',
    })
  })

  it('is case-insensitive and sees through nesting', () => {
    const redacted = redactContext({
      body: { XDR: 'AAAA', Password: 'x', owner: { Email: 'bob@test.com' } },
      keys: [{ apiKey: 'k' }, 'plain'],
    })

    expect(redacted).toEqual({
      body: { XDR: '[redacted]', Password: '[redacted]', owner: { Email: 'b…@test.com' } },
      keys: [{ apiKey: '[redacted]' }, 'plain'],
    })
  })

  it('masks an email that is not a string by redacting it whole', () => {
    expect(redactContext({ email: 42 })).toEqual({ email: '[redacted]' })
  })

  it('masks an email inside a string value under any key', () => {
    expect(redactContext({ note: 'sent to alice@test.com twice' })).toEqual({
      note: 'sent to a…@test.com twice',
    })
  })

  it('redacts a stellar secret seed under any key', () => {
    // A seed is unmistakable, and the key it arrives under is whatever the
    // caller happened to name it. The text around it stays: that is the
    // part that says what happened.
    const seed = `S${'A'.repeat(55)}`
    expect(redactContext({ note: `key ${seed} leaked`, list: [seed] })).toEqual({
      note: 'key [redacted] leaked',
      list: ['[redacted]'],
    })
  })
})

function harness(sink?: ReportSink) {
  const log = vi.fn()
  const reporter = createReporter({ log, ...(sink !== undefined ? { sink } : {}) })
  return { log, ...reporter }
}

function fakeSink(): ReportSink & { errors: unknown[][]; events: unknown[][] } {
  const errors: unknown[][] = []
  const events: unknown[][] = []
  return {
    errors,
    events,
    error: (where, error, context) => {
      errors.push([where, error, context])
    },
    event: (name, context) => {
      events.push([name, context])
    },
  }
}

describe('reportError', () => {
  it('logs a [where] tag, the message, and compact redacted context', () => {
    const { log, reportError } = harness()

    reportError('lend/build', new Error('Horizon 503'), { account: 'G1', signedXdr: 'AAAA' })

    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]?.[0]).toBe(
      '[lend/build] Horizon 503 {"account":"G1","signedXdr":"[redacted]"}'
    )
  })

  it('describes a thrown non-Error without context', () => {
    const { log, reportError } = harness()

    reportError('offers', 'horizon_unreachable')

    expect(log.mock.calls[0]?.[0]).toBe('[offers] horizon_unreachable')
  })

  it('forwards the redacted context to the sink', () => {
    const sink = fakeSink()
    const { reportError } = harness(sink)
    const error = new Error('boom')

    reportError('swap/submit', error, { email: 'alice@test.com' })

    expect(sink.errors).toEqual([['swap/submit', error, { email: 'a…@test.com' }]])
  })

  it('scrubs the error message itself, in the line, the stack and the copy', () => {
    // A thrower writes whatever it likes into a message — "could not email
    // alice@…" is a real one — and a message is text, not a keyed context.
    const sink = fakeSink()
    const { log, reportError } = harness(sink)
    const seed = `S${'A'.repeat(55)}`

    reportError('standing', new Error(`could not email alice@test.com with ${seed}`))

    expect(log.mock.calls[0]?.[0]).toBe('[standing] could not email a…@test.com with [redacted]')
    const logged = log.mock.calls[0]?.[1] as Error
    expect(logged.stack).not.toContain('alice@test.com')
    expect(logged.stack).not.toContain(seed)

    const forwarded = sink.errors[0]?.[1] as Error
    expect(forwarded).toBeInstanceOf(Error)
    expect(forwarded.message).toBe('could not email a…@test.com with [redacted]')
    expect(forwarded.stack).not.toContain('alice@test.com')
    // The frames survive: that is what Sentry groups on.
    expect(forwarded.stack).toContain('report.test.ts')
  })

  it('still logs when the sink throws', () => {
    const sink = fakeSink()
    sink.error = () => {
      throw new Error('sentry down')
    }
    const { log, reportError } = harness(sink)

    expect(() => reportError('x', new Error('y'))).not.toThrow()
    expect(log).toHaveBeenCalledTimes(1)
  })
})

describe('reportEvent', () => {
  it('logs the name with redacted context and forwards it', () => {
    const sink = fakeSink()
    const { log, reportEvent } = harness(sink)

    reportEvent('sponsor.low_balance', { balanceXlm: 5, secret: 'S…' })

    expect(log.mock.calls[0]?.[0]).toBe(
      '[sponsor.low_balance] {"balanceXlm":5,"secret":"[redacted]"}'
    )
    expect(sink.events).toEqual([['sponsor.low_balance', { balanceXlm: 5, secret: '[redacted]' }]])
  })
})
