/**
 * Sending email: OTP codes, word that a standing rule has fired, and alerts
 * to whoever runs the deployment.
 *
 * Two senders behind one interface. Development logs to the server console so
 * everything can be exercised with no API key and no verified domain;
 * production uses Resend. The choice is made by configuration, not by
 * scattered `if (dev)` checks at the call sites.
 */
export interface EmailSender {
  sendOtp: (to: string, code: string, ttlMinutes: number) => Promise<void>
  sendRuleFired: (to: string, fired: RuleFiredMail) => Promise<void>
  sendAlert: (to: string, mail: AlertMail) => Promise<void>
}

/**
 * An operator alert. Composed by whatever raised it — the watcher knows what
 * it saw — and carried as given.
 */
export interface AlertMail {
  subject: string
  text: string
}

/** What a fired-rule email has to carry. */
export interface RuleFiredMail {
  /** The rule in the user's terms, from `describeTrigger`. */
  description: string
  /** The price that crossed the level. Absent for a scheduled rule. */
  price?: number
  /** Opens the rule ready to sign. */
  link: string
}

/**
 * The fired-rule message, shared by both senders so the console shows what
 * production would send.
 *
 * Says "ready to sign", never "bought". A firing means the condition was met;
 * nothing has traded until the user signs, and an email claiming otherwise
 * would be the settled-rows-that-never-happened bug delivered to an inbox.
 */
function ruleFiredMessage(fired: RuleFiredMail): { subject: string; text: string } {
  const priceLine =
    fired.price === undefined ? `It is due now.` : `The price that crossed it was $${fired.price}.`

  return {
    subject: `Ready to sign: ${fired.description}`,
    text: [
      `Your standing rule has fired:`,
      ``,
      `  ${fired.description}`,
      ``,
      priceLine,
      ``,
      `Nothing has been traded. Open the rule and sign to execute it:`,
      fired.link,
      ``,
      `If you no longer want this rule, stop it from the same page.`,
    ].join('\n'),
  }
}

const consoleSender: EmailSender = {
  async sendOtp(to, code, ttlMinutes) {
    // eslint-disable-next-line no-console
    console.info(
      `\n  ── Intent access code ─────────────────\n` +
        `   to:   ${to}\n` +
        `   code: ${code}\n` +
        `   valid for ${ttlMinutes} minutes\n` +
        `  ───────────────────────────────────────\n`
    )
  },

  async sendRuleFired(to, fired) {
    const { subject, text } = ruleFiredMessage(fired)
    // eslint-disable-next-line no-console
    console.info(
      `\n  ── Standing rule fired ────────────────\n` +
        `   to:      ${to}\n` +
        `   subject: ${subject}\n` +
        text
          .split('\n')
          .map((line) => `   ${line}`)
          .join('\n') +
        `\n  ───────────────────────────────────────\n`
    )
  },

  async sendAlert(to, { subject, text }) {
    // eslint-disable-next-line no-console
    console.info(
      `\n  ── Alert ──────────────────────────────\n` +
        `   to:      ${to}\n` +
        `   subject: ${subject}\n` +
        text
          .split('\n')
          .map((line) => `   ${line}`)
          .join('\n') +
        `\n  ───────────────────────────────────────\n`
    )
  },
}

function resendSender(apiKey: string, from: string): EmailSender {
  async function send(to: string, subject: string, text: string): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, text }),
    })

    if (!res.ok) {
      // The body carries Resend's reason (unverified domain, bad key). Losing
      // it would make delivery failures undiagnosable in production.
      throw new Error(`Resend failed (${res.status}): ${await res.text()}`)
    }
  }

  return {
    async sendOtp(to, code, ttlMinutes) {
      await send(
        to,
        `${code} is your Intent access code`,
        [
          `Your Intent access code is ${code}.`,
          ``,
          `It expires in ${ttlMinutes} minutes.`,
          `If you did not request this, you can ignore this email.`,
        ].join('\n')
      )
    },

    async sendRuleFired(to, fired) {
      const { subject, text } = ruleFiredMessage(fired)
      await send(to, subject, text)
    },

    async sendAlert(to, { subject, text }) {
      await send(to, subject, text)
    },
  }
}

export function getEmailSender(): EmailSender {
  const apiKey = process.env['RESEND_API_KEY']
  const from = process.env['EMAIL_FROM']

  if (apiKey !== undefined && apiKey !== '' && from !== undefined && from !== '') {
    return resendSender(apiKey, from)
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('RESEND_API_KEY and EMAIL_FROM are required in production')
  }

  return consoleSender
}
