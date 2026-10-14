/**
 * One general question-asker that runs before the race.
 *
 * Agents do not ask anything: they are models competing on identical facts, and
 * several of them each asking their own questions would mean several threads in
 * the UI and answers that differ between them. This asks once, on their behalf.
 * When it has what the order needs, it hands back a brief that every agent
 * receives unchanged.
 *
 * Like the intent parser, it may answer "I cannot help" (null), and the caller
 * then carries on with what the user typed. An outage or a missing key must
 * leave the app exactly as capable as it was before this existed.
 */

const MODEL = 'deepseek-flash'
const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'
const TIMEOUT_MS = 8_000
const MAX_OUTPUT_TOKENS = 500

/** A user can be asked this many questions before the app stops and carries on. */
const MAX_QUESTIONS = 5

/** Nigerian bank accounts (NUBAN) are ten digits. Checked in code, never trusted to a model. */
const ACCOUNT_NUMBER = /^\d{10}$/

export interface ClarifyTurn {
  role: 'user' | 'assistant'
  content: string
}

/** Where the money is going. Stays between the user, this app and the payout provider. */
export interface Payout {
  bankName: string
  accountNumber: string
}

export type ClarifyResult =
  | { status: 'ask'; question: string }
  | {
      status: 'ready'
      /** The brief every agent receives. Holds nothing an agent does not need to choose a route. */
      context: string[]
      payout?: Payout
    }

export interface ClarifyOptions {
  apiKey?: string
  baseUrl?: string
  model?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const CLARIFY_TOOL = {
  type: 'function',
  function: {
    name: 'clarify',
    description:
      'Decide whether the order is clear enough to hand to the agents, or ask one question.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['ask', 'ready'],
          description: "'ask' when something the order needs is missing. 'ready' when nothing is.",
        },
        question: {
          type: 'string',
          description: "One short question for the user when status is 'ask'. Empty otherwise.",
        },
        facts: {
          type: 'array',
          items: { type: 'string' },
          description:
            "When ready: what the user confirmed, one 'Label: value' line each (asset, amount, destination currency, bank name). NEVER an account number or an account holder's name.",
        },
        bankName: {
          type: 'string',
          description:
            'The bank named by the user, when the order pays out to a bank. Empty otherwise.',
        },
        accountNumber: {
          type: 'string',
          description:
            'The bank account number the user gave, digits only. Empty when none was given.',
        },
      },
      required: ['status', 'question', 'facts', 'bankName', 'accountNumber'],
    },
  },
}

const SYSTEM_PROMPT = [
  'You prepare a user order for a group of trading agents. Call clarify exactly once.',
  'Ask only for what the order cannot be carried out without, one question at a time, in plain words.',
  'A swap needs the asset being sold, the asset received and a size. If the user named them, do not ask again.',
  'An order that ends in Nigerian naira, a bank, or cashing out also needs the bank name and the bank account number.',
  'Do not ask for the account holder name: it is looked up from the bank.',
  'Never ask about price, venue or route: the agents decide those.',
  'Never ask something the user already answered earlier in the conversation.',
  'When nothing is missing, set status to ready and list what was confirmed in facts.',
  'facts must never contain an account number or an account holder name.',
].join(' ')

export async function clarifyWithLlm(
  turns: ClarifyTurn[],
  options: ClarifyOptions = {}
): Promise<ClarifyResult | null> {
  const apiKey = options.apiKey ?? process.env['DEEPSEEK_API_KEY']
  if (apiKey === undefined || apiKey === '') return null

  const asked = turns.filter((t) => t.role === 'assistant').length
  if (asked >= MAX_QUESTIONS) return null

  const baseUrl = options.baseUrl ?? process.env['DEEPSEEK_BASE_URL'] ?? DEFAULT_BASE_URL
  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS)

  let payload: unknown
  try {
    const res = await doFetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: options.model ?? MODEL,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...turns],
        tools: [CLARIFY_TOOL],
        tool_choice: 'auto',
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: controller.signal,
    })
    if (!res.ok) return null
    payload = await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }

  return interpret(payload)
}

interface ToolArguments {
  status?: unknown
  question?: unknown
  facts?: unknown
  bankName?: unknown
  accountNumber?: unknown
}

function toolArgumentsOf(payload: unknown): ToolArguments | null {
  try {
    const choices = (payload as { choices?: { message?: { tool_calls?: unknown } }[] }).choices
    const calls = choices?.[0]?.message?.tool_calls
    if (!Array.isArray(calls) || calls.length === 0) return null
    const raw = (calls[0] as { function?: { arguments?: unknown } }).function?.arguments
    return typeof raw === 'string' ? (JSON.parse(raw) as ToolArguments) : null
  } catch {
    return null
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function interpret(payload: unknown): ClarifyResult | null {
  const args = toolArgumentsOf(payload)
  if (args === null) return null

  if (args.status === 'ask') {
    const question = text(args.question)
    return question === '' ? null : { status: 'ask', question }
  }
  if (args.status !== 'ready') return null

  const bankName = text(args.bankName)
  const accountNumber = text(args.accountNumber).replace(/\s+/g, '')

  // A bank was named, so the payout is part of the order and its account number
  // has to be right. The model's reading of a number is not good enough for money.
  if (bankName !== '' || accountNumber !== '') {
    if (!ACCOUNT_NUMBER.test(accountNumber)) {
      return { status: 'ask', question: 'Please send the bank account number as 10 digits.' }
    }
    if (bankName === '') {
      return { status: 'ask', question: 'Which bank is that account with?' }
    }
  }

  // The brief goes to third-party model providers. A number slipping into it
  // despite the instruction is dropped here, not left to the prompt.
  const context = (Array.isArray(args.facts) ? args.facts : [])
    .filter((f): f is string => typeof f === 'string')
    .map((f) => f.trim())
    .filter((f) => f !== '' && (accountNumber === '' || !f.includes(accountNumber)))

  return {
    status: 'ready',
    context,
    ...(bankName !== '' ? { payout: { bankName, accountNumber } } : {}),
  }
}
