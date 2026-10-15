/**
 * One general question-asker that runs before the race.
 *
 * Agents do not ask anything: they are models competing on identical facts, and
 * several of them each asking their own questions would mean several threads in
 * the UI and answers that differ between them. This asks once, on their behalf.
 * When nothing material is missing it hands back the instruction as one
 * standalone sentence and a brief that every agent receives unchanged.
 *
 * Standalone matters for follow-ups. "now send half of it to deon.xlm" is only
 * an instruction next to the trade before it; the rewrite is what the existing
 * parsers and the agents then read, so they never need to resolve "it".
 *
 * Like the intent parser, it may answer "I cannot help" (null), and the caller
 * then carries on with what the user typed. An outage or a missing key must
 * leave the app exactly as capable as it was before this existed.
 */

import { intentModels, type IntentModel } from '../llm/intent-models'

const MODEL = 'deepseek-flash'
const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'
const TIMEOUT_MS = 8_000
const MAX_OUTPUT_TOKENS = 500

/** A user can be asked this many questions before the app stops and carries on. */
const MAX_QUESTIONS = 4

export interface ClarifyTurn {
  role: 'user' | 'assistant'
  content: string
}

export type ClarifyResult =
  | { status: 'ask'; question: string }
  | {
      status: 'ready'
      /** The latest request as one sentence that needs nothing before it to be understood. */
      instruction: string
      /** What was confirmed, one line each. The brief every agent receives. */
      context: string[]
    }

export interface ClarifyOptions {
  apiKey?: string
  baseUrl?: string
  model?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** What the conversation already established, one line each. */
  context?: string[]
}

const CLARIFY_TOOL = {
  type: 'function',
  function: {
    name: 'clarify',
    description:
      'Decide whether the request is clear enough to hand to the trading agents, or ask one question.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['ask', 'ready'],
          description: "'ask' when something the request cannot be carried out without is missing.",
        },
        question: {
          type: 'string',
          description: "One short question for the user when status is 'ask'. Empty otherwise.",
        },
        instruction: {
          type: 'string',
          description:
            "When ready: the user's latest request, with everything they said in answers and everything it refers to from earlier in the chat written out, as one self-contained sentence. Empty when asking.",
        },
        facts: {
          type: 'array',
          items: { type: 'string' },
          description:
            "When ready: what the user confirmed, one 'Label: value' line each, such as the asset, the amount or the destination currency. Never an account number or a name.",
        },
      },
      required: ['status', 'question', 'instruction', 'facts'],
    },
  },
}

const SYSTEM_PROMPT = [
  'You prepare a user request for a group of trading agents on the Stellar network. Call clarify exactly once.',
  'If the request is complete, set status to ready right away. Do not ask for confirmation of something already clear.',
  'Ask only for what the request cannot be carried out without, one question at a time, in plain words.',
  'A trade needs the asset sold, the asset received, and a size (an amount of the asset, or a dollar amount).',
  'Cashing out to a bank is possible only to Nigerian naira (NGN), from XLM or USDC. If the user says off-ramp or cash out',
  'without a currency, ask which asset they are cashing out and say the payout is to naira.',
  'If they ask for another currency, ready is wrong: ask whether they want naira instead.',
  'Do NOT ask for a bank, an account number or an account name: a form collects those afterwards.',
  'Never ask about price, slippage, venue or route: the agents decide those.',
  'Never ask something the user already answered, or that the earlier conversation already settles.',
  'Earlier turns of the chat are given as context. A request like "send half of it to deon.xlm" refers to them:',
  'write it out in instruction ("Send 1 USDC to deon.xlm") using the amounts from the context.',
  'If you cannot work out what "it" is from the context, ask.',
  'facts must never contain an account number or a person’s name.',
  'Correct obvious typos in the instruction when you write it out: "edge 5 USDC exposure" means "hedge 5 USDC exposure".',
  'Hedging an asset means moving that exposure into another asset. If the request says hedge or reduce exposure to something',
  'and does not say what to move into, ask one question for it and offer XLM as an example.',
  'Never mark a request ready when you cannot tell what the user wants done; ask instead of passing the words along.',
].join(' ')

export async function clarifyWithLlm(
  turns: ClarifyTurn[],
  options: ClarifyOptions = {}
): Promise<ClarifyResult | null> {
  // After this many questions the user has said all they are going to. Carry on
  // with what they said rather than interrogating them.
  const asked = turns.filter((t) => t.role === 'assistant').length
  if (asked >= MAX_QUESTIONS) return null

  // One explicit key is one model, as before. Otherwise each configured model
  // is tried in turn, so an exhausted free tier hands over instead of failing.
  const models: IntentModel[] =
    options.apiKey !== undefined
      ? options.apiKey === ''
        ? []
        : [
            {
              id: 'deepseek',
              apiKey: options.apiKey,
              baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
              model: options.model ?? MODEL,
            },
          ]
      : intentModels().map((m) => ({
          ...m,
          ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
        }))

  for (const model of models) {
    const result = await clarifyWithModel(turns, options, model)
    if (result !== null) return result
  }
  return null
}

async function clarifyWithModel(
  turns: ClarifyTurn[],
  options: ClarifyOptions,
  config: IntentModel
): Promise<ClarifyResult | null> {
  const { apiKey, baseUrl } = config
  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS)

  const context = (options.context ?? []).filter((l) => l.trim() !== '').slice(0, 6)
  const system =
    context.length === 0
      ? SYSTEM_PROMPT
      : `${SYSTEM_PROMPT} Context from earlier in this chat:\n${context.join('\n')}`

  let payload: unknown
  try {
    const res = await doFetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'system', content: system }, ...turns],
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
  instruction?: unknown
  facts?: unknown
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

/** Long enough for any sentence a person types here, short enough to bound what is passed on. */
const MAX_INSTRUCTION_CHARS = 400

/** A run of ten or more digits is an account number, or close enough to one to keep off a third party. */
const LONG_NUMBER = /\d{10,}/

function interpret(payload: unknown): ClarifyResult | null {
  const args = toolArgumentsOf(payload)
  if (args === null) return null

  if (args.status === 'ask') {
    const question = text(args.question)
    return question === '' ? null : { status: 'ask', question }
  }
  if (args.status !== 'ready') return null

  const instruction = text(args.instruction).slice(0, MAX_INSTRUCTION_CHARS)
  // Without a usable sentence there is nothing to run, and the caller falls
  // back to what the user typed.
  if (instruction === '') return null

  // The brief goes to third-party model providers, so anything that looks like
  // an account number is dropped here rather than left to the prompt.
  const context = (Array.isArray(args.facts) ? args.facts : [])
    .filter((f): f is string => typeof f === 'string')
    .map((f) => f.trim())
    .filter((f) => f !== '' && !LONG_NUMBER.test(f))
    .slice(0, 8)

  return { status: 'ready', instruction, context }
}
