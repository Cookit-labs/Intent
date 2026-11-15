import { alertRecipient } from '../server/alerts'
import { getEmailSender } from '../server/email'
import { reportError } from '../server/report'
import type { Ticket } from './tickets'

/**
 * Emails about tickets. A failed email never fails the request that caused it: the ticket is saved
 * and shows in the admin and in the widget either way.
 */

const ADMIN_PATH = '/admin/tickets'

async function send(to: string, subject: string, text: string): Promise<void> {
  try {
    await getEmailSender().sendAlert(to, { subject, text })
  } catch (e) {
    reportError('support/notify', e, { subject })
  }
}

/** Tells the team a ticket was filed, or that the person replied on one. */
export async function notifyTeam(ticket: Ticket, event: 'new' | 'reply'): Promise<void> {
  const to = alertRecipient()
  if (to === undefined) return
  const subject =
    event === 'new' ? `New ${ticket.kind}: ${ticket.title}` : `Reply on ticket: ${ticket.title}`
  const text = [
    event === 'new' ? 'A new help ticket was filed.' : 'The person replied on a help ticket.',
    '',
    `Title: ${ticket.title}`,
    `Kind: ${ticket.kind}`,
    `Chain: ${ticket.chain ?? 'unknown'}`,
    '',
    ticket.summary,
    '',
    `Open it in the admin under ${ADMIN_PATH}.`,
  ].join('\n')
  await send(to, subject, text)
}

/** Tells the person the team replied, when they gave an email. Wallet-only people see the badge. */
export async function notifyPerson(ticket: Ticket): Promise<void> {
  if (ticket.requester.startsWith('wallet:') || !ticket.requester.includes('@')) return
  await send(
    ticket.requester,
    'The Intent team replied to your help request',
    [
      `The team replied to "${ticket.title}".`,
      '',
      'Open Intent and tap the help button at the bottom right to read it and reply.',
    ].join('\n')
  )
}
