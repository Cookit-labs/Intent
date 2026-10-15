import { describe, expect, it } from 'vitest'

import { renderOtpEmail, renderRuleFiredEmail } from '../server/email-templates'

describe('renderOtpEmail', () => {
  it('shows the code and its lifetime in both bodies', () => {
    const mail = renderOtpEmail('042677', 10)
    expect(mail.html).toContain('042677')
    expect(mail.html).toContain('10 minutes')
    expect(mail.text).toContain('042677')
    expect(mail.text).toContain('10 minutes')
  })

  it('loads nothing remote', () => {
    const { html } = renderOtpEmail('042677', 10)
    expect(html).not.toMatch(/<img|<script|<link|url\(/i)
  })
})

describe('renderRuleFiredEmail', () => {
  it('escapes what a rule description carries', () => {
    const mail = renderRuleFiredEmail(
      'Buy <b>XLM</b> & "more"',
      'It is due now.',
      'https://x.test/r'
    )
    expect(mail.html).not.toContain('<b>XLM</b>')
    expect(mail.html).toContain('&lt;b&gt;XLM&lt;/b&gt;')
  })

  it('links only http(s) addresses', () => {
    const ok = renderRuleFiredEmail('r', 'p', 'https://app.test/rules/1')
    expect(ok.html).toContain('href="https://app.test/rules/1"')
    const bad = renderRuleFiredEmail('r', 'p', 'javascript:alert(1)')
    expect(bad.html).not.toContain('href="javascript')
  })
})
