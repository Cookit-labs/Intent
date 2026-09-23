import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getEmailSender } from '../server/email'

/**
 * The email a fired rule sends.
 *
 * Plain text, and it has to carry three things: what the rule was, in the
 * user's terms; the price that crossed it; and a link that opens the rule
 * ready to sign. Nothing in it claims a trade happened — a firing is a prompt,
 * and an email saying "bought" for a swap nobody signed would be the settled-
 * rows-that-never-happened bug in a new medium.
 */

const FIRED = {
  description: '50 USDC → XLM when XLM falls to $0.16',
  price: 0.155,
  link: 'https://intent.example/stellar/intents?rule=si_1',
}

describe('the console sender', () => {
  beforeEach(() => {
    delete process.env['RESEND_API_KEY']
    delete process.env['EMAIL_FROM']
  })

  it('prints the rule, the price and the link', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    await getEmailSender().sendRuleFired('alice@test.com', FIRED)

    const printed = info.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(printed).toContain('alice@test.com')
    expect(printed).toContain(FIRED.description)
    expect(printed).toContain('0.155')
    expect(printed).toContain(FIRED.link)
    info.mockRestore()
  })
})

describe('the Resend sender', () => {
  beforeEach(() => {
    process.env['RESEND_API_KEY'] = 're_test'
    process.env['EMAIL_FROM'] = 'Intent <rules@intent.example>'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env['RESEND_API_KEY']
    delete process.env['EMAIL_FROM']
  })

  it('sends plain text with the rule, the price and the link', async () => {
    let sent: { to?: string; from?: string; subject?: string; text?: string } | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        sent = JSON.parse(init.body) as typeof sent
        return new Response('{}', { status: 200 })
      })
    )

    await getEmailSender().sendRuleFired('alice@test.com', FIRED)

    expect(sent?.to).toBe('alice@test.com')
    expect(sent?.from).toBe('Intent <rules@intent.example>')
    expect(sent?.subject).toContain(FIRED.description)
    expect(sent?.text).toContain(FIRED.description)
    expect(sent?.text).toContain('$0.155')
    expect(sent?.text).toContain(FIRED.link)
    // A firing is a prompt to sign, and the wording must not imply otherwise.
    expect(sent?.text?.toLowerCase()).toContain('sign')
    expect(sent?.text?.toLowerCase()).not.toContain('bought')
  })

  it('surfaces a failed send rather than swallowing it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('domain not verified', { status: 403 }))
    )

    await expect(getEmailSender().sendRuleFired('alice@test.com', FIRED)).rejects.toThrow(
      /403.*domain not verified/
    )
  })
})
