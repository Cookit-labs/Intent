/**
 * The HTML of the emails Intent sends.
 *
 * Table layout with inline styles, because mail clients ignore most of what a
 * stylesheet says and several strip it entirely. No remote images: a client
 * that blocks them would show a broken box where the logo was, so the wordmark
 * is text. Every value that reaches the markup is escaped, and a link is only
 * ever an http(s) URL.
 *
 * Each template returns the plain-text body too. It is what the preview pane
 * and a text-only client show, so it carries the whole message.
 */

const BRAND = '#3f44a7'
const INK = '#14161f'
const MUTED = '#5d6275'
const LINE = '#e3e5ee'
const PAPER = '#f4f5fa'
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"
const MONO = "'SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace"

export interface RenderedEmail {
  html: string
  text: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeUrl(url: string): string | undefined {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined
  } catch {
    return undefined
  }
}

function layout(options: { preheader: string; heading: string; body: string }): string {
  const { preheader, heading, body } = options
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${PAPER};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${PAPER};">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">
<tr><td style="padding:0 4px 20px;font:700 20px/1 ${SANS};color:${BRAND};letter-spacing:-0.2px;">Intent</td></tr>
<tr><td style="background:#ffffff;border:1px solid ${LINE};border-radius:16px;padding:32px 28px;font:400 15px/1.55 ${SANS};color:${INK};">
<h1 style="margin:0 0 16px;font:600 20px/1.3 ${SANS};color:${INK};">${escapeHtml(heading)}</h1>
${body}
</td></tr>
<tr><td style="padding:20px 8px 0;font:400 12px/1.5 ${SANS};color:${MUTED};text-align:center;">
Sent by Intent. If this was not you, you can ignore this email; nothing happens until the code is used.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
}

/** The access code email. */
export function renderOtpEmail(code: string, ttlMinutes: number): RenderedEmail {
  const safeCode = escapeHtml(code)
  const body = `<p style="margin:0 0 20px;">Use this code to sign in. It works once.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr>
<td style="background:${PAPER};border:1px solid ${LINE};border-radius:12px;padding:16px 24px;font:700 32px/1 ${MONO};letter-spacing:8px;color:${INK};">${safeCode}</td>
</tr></table>
<p style="margin:0;color:${MUTED};">It expires in ${ttlMinutes} minutes. Never share it: nobody from Intent will ask for it.</p>`

  return {
    html: layout({
      preheader: `${code} is your Intent access code. It expires in ${ttlMinutes} minutes.`,
      heading: 'Your access code',
      body,
    }),
    text: [
      `Your Intent access code is ${code}.`,
      ``,
      `It expires in ${ttlMinutes} minutes and works once.`,
      `Never share it: nobody from Intent will ask for it.`,
      ``,
      `If you did not request this, you can ignore this email.`,
    ].join('\n'),
  }
}

/** The standing-rule-fired email. Says "ready to sign": nothing has traded. */
export function renderRuleFiredEmail(
  description: string,
  priceLine: string,
  link: string
): RenderedEmail {
  const href = safeUrl(link)
  const button =
    href === undefined
      ? ''
      : `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 0;"><tr>
<td style="background:${BRAND};border-radius:999px;"><a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 24px;font:600 15px/1 ${SANS};color:#ffffff;text-decoration:none;">Review and sign</a></td>
</tr></table>`

  const body = `<p style="margin:0 0 16px;">Your standing rule has fired:</p>
<p style="margin:0 0 16px;padding:14px 16px;background:${PAPER};border:1px solid ${LINE};border-radius:12px;font-weight:600;">${escapeHtml(description)}</p>
<p style="margin:0;color:${MUTED};">${escapeHtml(priceLine)} Nothing has been traded. Open the rule and sign to execute it.</p>
${button}`

  return {
    html: layout({
      preheader: `Ready to sign: ${description}`,
      heading: 'Ready to sign',
      body,
    }),
    text: [
      `Your standing rule has fired:`,
      ``,
      `  ${description}`,
      ``,
      priceLine,
      ``,
      `Nothing has been traded. Open the rule and sign to execute it:`,
      link,
      ``,
      `If you no longer want this rule, stop it from the same page.`,
    ].join('\n'),
  }
}
