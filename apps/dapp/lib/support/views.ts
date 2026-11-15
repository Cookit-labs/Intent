import type { Ticket, TicketMessage, TicketWithMessages } from './tickets'

/** What the person sees of their own ticket: no requester key, no order data. */
export interface PersonTicketView {
  id: string
  kind: Ticket['kind']
  status: Ticket['status']
  title: string
  unread: boolean
  updatedAt: string
  messages?: TicketMessage[]
}

export function toPersonView(ticket: Ticket | TicketWithMessages): PersonTicketView {
  return {
    id: ticket.id,
    kind: ticket.kind,
    status: ticket.status,
    title: ticket.title,
    unread: ticket.userUnread,
    updatedAt: ticket.updatedAt,
    ...('messages' in ticket ? { messages: ticket.messages } : {}),
  }
}
