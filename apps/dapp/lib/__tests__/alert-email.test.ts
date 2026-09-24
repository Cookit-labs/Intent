import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getEmailSender } from '../server/email'

/**
 * The operator alert, through both senders.
 *
 * Unlike the fired-rule email, the caller composes the message: an alert is
 * whatever the watcher that raised it needs to say. The senders only carry
 * it — to the console in development, through Resend in production.
 */

const ALERT = {
  subject: 'Sponsor balance low: 5.0000000 XLM',
  text: 'The fee sponsor holds 5.0000000 XLM, below the 20 XLM threshold.',
}

describe('the console sender', () => {
  beforeEach(() => {
    delete process.env['RESEND_API_KEY']
    delete process.env['EMAIL_FROM']
  })

  it('prints the recipient, the subject and the text', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    await getEmailSender().sendAlert('ops@test.com', ALERT)

    const printed = info.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(printed).toContain('ops@test.com')
    expect(printed).toContain(ALERT.subject)
    expect(printed).toContain(ALERT.text)
    info.mockRestore()
  })
})

describe('the Resend sender', () => {
  beforeEach(() => {
    process.env['RESEND_API_KEY'] = 're_test'
    process.env['EMAIL_FROM'] = 'Intent <alerts@intent.example>'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env['RESEND_API_KEY']
    delete process.env['EMAIL_FROM']
  })

  it('sends the subject and text as given', async () => {
    let sent: { to?: string; from?: string; subject?: string; text?: string } | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        sent = JSON.parse(init.body) as typeof sent
        return new Response('{}', { status: 200 })
      })
    )

    await getEmailSender().sendAlert('ops@test.com', ALERT)

    expect(sent).toEqual({
      to: 'ops@test.com',
      from: 'Intent <alerts@intent.example>',
      subject: ALERT.subject,
      text: ALERT.text,
    })
  })
})
