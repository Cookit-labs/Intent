/**
 * Sending OTP codes.
 *
 * Two senders behind one interface. Development logs the code to the server
 * console so the whole gate can be exercised with no API key and no verified
 * domain; production uses Resend. The choice is made by configuration, not by
 * scattered `if (dev)` checks at the call sites.
 */
export interface EmailSender {
  sendOtp: (to: string, code: string, ttlMinutes: number) => Promise<void>
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
}

function resendSender(apiKey: string, from: string): EmailSender {
  return {
    async sendOtp(to, code, ttlMinutes) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to,
          subject: `${code} is your Intent access code`,
          text: [
            `Your Intent access code is ${code}.`,
            ``,
            `It expires in ${ttlMinutes} minutes.`,
            `If you did not request this, you can ignore this email.`,
          ].join('\n'),
        }),
      })

      if (!res.ok) {
        // The body carries Resend's reason (unverified domain, bad key). Losing
        // it would make delivery failures undiagnosable in production.
        throw new Error(`Resend failed (${res.status}): ${await res.text()}`)
      }
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
