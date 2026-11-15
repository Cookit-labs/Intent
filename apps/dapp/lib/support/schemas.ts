import { z } from 'zod'

import { MAX_TURNS } from './assistant'
import { MAX_MESSAGE_CHARS, TICKET_KINDS, TICKET_STATUSES } from './tickets'

const text = z.string().trim().min(1).max(MAX_MESSAGE_CHARS)

const turns = z
  .array(z.object({ role: z.enum(['user', 'assistant']), text }))
  .min(1)
  .max(MAX_TURNS * 2)

export const chatBody = z.object({ turns, chain: z.string().max(16).optional() })

export const newTicketBody = z.object({
  turns,
  chain: z.string().max(16).optional(),
  draft: z.object({
    kind: z.enum(TICKET_KINDS),
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().max(1000),
  }),
})

export const replyBody = z.object({ text })

export const statusBody = z.object({ status: z.enum(TICKET_STATUSES) })
