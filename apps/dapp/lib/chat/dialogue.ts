import type { ClarifyTurn } from '../clarify/clarify'

/** Four exchanges: enough to explain "that part" and not to drag an old topic along. */
const MAX_TURNS = 8

/**
 * The conversation the model is shown with the next message: what was asked and
 * what it answered, most recent last.
 *
 * Limits match the route's, so a long reply is cut here rather than rejecting
 * the whole request.
 */
export function rememberExchange(
  dialogue: ClarifyTurn[],
  message: string,
  reply: string
): ClarifyTurn[] {
  return [
    ...dialogue,
    { role: 'user' as const, content: message.slice(0, 500) },
    { role: 'assistant' as const, content: reply.slice(0, 700) },
  ].slice(-MAX_TURNS)
}
