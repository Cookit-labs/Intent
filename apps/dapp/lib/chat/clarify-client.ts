import type { ClarifyResult, ClarifyTurn } from '../clarify/clarify'

/**
 * Asks the server whether a request needs a question first.
 *
 * Never throws and never blocks the chat: any failure, a `skip` answer, or a
 * reply that is not recognisable comes back as `null`, and the caller runs what
 * the user typed. The chat is exactly as capable without the model as it was
 * before there was one.
 */
export async function fetchClarify(
  turns: ClarifyTurn[],
  context: string[],
  fetchImpl: typeof fetch = fetch
): Promise<ClarifyResult | null> {
  try {
    const res = await fetchImpl('/api/intent/clarify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turns, ...(context.length > 0 ? { context } : {}) }),
    })
    if (!res.ok) return null
    const answer = (await res.json()) as {
      status?: unknown
      question?: unknown
      instruction?: unknown
      context?: unknown
    }
    if (answer.status === 'ask' && typeof answer.question === 'string' && answer.question !== '') {
      return { status: 'ask', question: answer.question }
    }
    if (answer.status === 'ready' && typeof answer.instruction === 'string') {
      return {
        status: 'ready',
        instruction: answer.instruction,
        context: Array.isArray(answer.context)
          ? answer.context.filter((c): c is string => typeof c === 'string')
          : [],
      }
    }
    return null
  } catch {
    return null
  }
}
