import { intentModels, type IntentModel } from '../llm/intent-models'
import { capabilitySheet } from './capabilities'
import {
  READ_INTENT_PROPERTIES,
  READ_INTENT_REQUIRED,
  readingFromArguments,
  type LlmReadIntent,
  type ReadIntentOptions,
  type ToolArguments,
} from '../parse-intent-llm'

/**
 * The one reader every typed message goes through.
 *
 * It decides what the message is before any keyword code looks at it: an
 * instruction to carry out, something unclear enough to need a question, a
 * request to be told what Intent can do, or something that has nothing to do
 * with Intent at all. Matching words cannot make that call — "flip my lumens
 * into dollars" contains no verb a list would have — and a message no list
 * recognises used to be run anyway, as a default purchase.
 *
 * It answers "I could not read that" (null) and the caller says so. There is
 * deliberately no fallback to a keyword reading: a reading that cannot tell a
 * trade from "I want to go jogging" is worse than none.
 */

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'
const MODEL = 'deepseek-flash'
const TIMEOUT_MS = 8_000
const MAX_OUTPUT_TOKENS = 700

/** A user can be asked this many questions before the app stops asking. */
const MAX_QUESTIONS = 4

export interface OrchestrateTurn {
  role: 'user' | 'assistant'
  content: string
}

/** How the trade is to be placed. The words for each vary without limit; the meaning does not. */
export type OrderStyle =
  | 'market'
  | 'limit'
  | 'accumulate'
  | 'hedge'
  | 'rebalance'
  | 'route_liquidity'

const ORDER_STYLES: readonly OrderStyle[] = [
  'market',
  'limit',
  'accumulate',
  'hedge',
  'rebalance',
  'route_liquidity',
]

/** Which asset a bare quantity counts: the one given up, or the one received. */
export type AmountOf = 'sent' | 'received'

const AMOUNT_OF: readonly AmountOf[] = ['sent', 'received']

export type OrchestrateResult =
  | {
      status: 'act'
      reading: LlmReadIntent
      style: OrderStyle
      /**
       * What a size that is not in dollars counts. "turn 20 USDC into XLM" is 20
       * of what is sent; "buy 300 XLM" is 300 of what is received. Guessing it
       * from which side is a stablecoin sized the first as 20 XLM.
       */
      amountOf?: AmountOf
      /** The price the user named for a limit order, and nothing else. */
      limitPriceUsd?: number
      /** The latest request as one sentence that needs nothing before it to be understood. */
      instruction: string
      /** What was confirmed, one line each. The brief every agent receives. */
      context: string[]
    }
  | { status: 'ask'; question: string }
  /**
   * `reply` is what the model said back, in its own words and in the flow of the
   * conversation. Absent only when it said nothing usable, and the caller then
   * falls back to fixed text.
   */
  | { status: 'help'; reply?: string }
  | { status: 'out_of_scope'; reply?: string }
  /** Four questions asked and the request is still not usable. */
  | { status: 'unclear'; reply?: string }

export interface OrchestrateOptions extends ReadIntentOptions {
  /** The chain the user is on, which decides what the fact sheet says Intent does. */
  chain?: string
  /** What the conversation already established, one line each. */
  context?: string[]
  /**
   * The earlier turns of this chat, replies included. Sent before `turns` and
   * never counted as questions asked: it is what lets the model explain
   * something differently the second time instead of repeating itself.
   */
  history?: OrchestrateTurn[]
}

const ORCHESTRATE_TOOL = {
  type: 'function',
  function: {
    name: 'orchestrate',
    description: 'Decide what a message to Intent is, and read it when it is an instruction.',
    parameters: {
      type: 'object',
      properties: {
        outcome: {
          type: 'string',
          enum: ['act', 'ask', 'help', 'out_of_scope'],
          description:
            "'act' when the message is a complete instruction Intent can carry out. 'ask' when it is about Intent's work but something it cannot be carried out without is missing or unclear. 'help' when the user asks what they can do or how Intent works. 'out_of_scope' when it has nothing to do with Intent's work.",
        },
        question: {
          type: 'string',
          description: "One short question for the user when outcome is 'ask'. Empty otherwise.",
        },
        reply: {
          type: 'string',
          description:
            "When outcome is 'help' or 'out_of_scope': what you say back to the person, in your own words, as a natural reply to their latest message in this conversation. Empty otherwise.",
        },
        instruction: {
          type: 'string',
          description:
            "When 'act': the user's latest request, with their answers and everything it refers to from earlier in the chat written out, as one self-contained sentence. Empty otherwise.",
        },
        facts: {
          type: 'array',
          items: { type: 'string' },
          description:
            "When 'act': what the user confirmed, one 'Label: value' line each, such as the asset, the amount or the destination currency. Never an account number or a name.",
        },
        amountOf: {
          type: 'string',
          enum: AMOUNT_OF,
          description:
            'When amountIsUsd is false: which asset the number counts. \'sent\' is the asset the user gives up ("sell 100 XLM", "turn 20 USDC into XLM", "swap 5 XLM to USDC"). \'received\' is the asset they get ("buy 300 XLM", "get me 50 USDC"). Use \'sent\' when amountIsUsd is true.',
        },
        orderStyle: {
          type: 'string',
          enum: ORDER_STYLES,
          description:
            "When 'act': how the trade is placed. 'market' trades now at the going price. 'limit' only at or beyond a named price. 'accumulate' spreads buying over time. 'hedge' moves exposure into another asset. 'rebalance' restores a target mix. 'route_liquidity' asks for the best route.",
        },
        limitPriceUsd: {
          type: 'number',
          description:
            "The price in US dollars the user named as a ceiling or floor, when orderStyle is 'limit'. 0 when none was named. Never the size.",
        },
        ...READ_INTENT_PROPERTIES,
      },
      required: [
        'outcome',
        'question',
        'reply',
        'instruction',
        'facts',
        'orderStyle',
        'limitPriceUsd',
        'amountOf',
        ...READ_INTENT_REQUIRED,
      ],
    },
  },
}

const BASE_PROMPT = [
  'You are the front door of Intent, an app where people state what they want done with their money on the Stellar network and trading agents compete to do it. Call orchestrate exactly once.',
  "Decide by what the person MEANS, not by which words they used: 'flip', 'turn into', 'get me some', 'move my lumens to dollars' are all trades.",
  "Use outcome 'out_of_scope' for anything unrelated to that work — exercise, weather, recipes, general chat. Do not try to stretch an unrelated message into a trade.",
  "Use outcome 'help' when the person asks what they can do, what Intent is, how to get started, or asks you to explain something Intent does.",
  'For help and out_of_scope, write reply yourself, in your own words, as a person would in a conversation. Answer exactly what they asked: if they ask about one thing, explain that one thing rather than listing everything.',
  'The facts about Intent below are what is true, not wording to copy. If what they ask for is not in the facts, say plainly that Intent does not do it. Never promise a feature that is not listed.',
  'Earlier turns of this conversation are given, including your own replies. Never repeat an earlier reply. If they ask you to explain better, or do not understand, explain it a different way: simpler, with a concrete example, or from another angle.',
  'For an out_of_scope message, answer like a person: acknowledge what they said, say that it is outside what Intent does, and mention one or two things Intent could help with that fit what they said. Do not lecture and do not use a stock sentence.',
  "Use outcome 'ask' whenever you cannot tell what they want done or something it needs is missing. Ask one question, in plain words. Never guess, and never pass unclear words along as an instruction.",
  "Use outcome 'act' as soon as the request is complete. Do not ask for confirmation of something already clear.",
  'A trade needs the asset sold, the asset received, and a size (an amount of the asset, or a dollar amount).',
  'If the person names only one side of a trade, ask what the other side is, in one question. Never leave tokenIn or tokenOut empty in an act.',
  'Do NOT ask for a bank, an account number or an account name: a form collects those afterwards.',
  'Never ask about price, slippage, venue or route: the agents decide those.',
  'Never ask something the user already answered, or that the earlier conversation already settles.',
  'Earlier turns of the chat are given as context. A request like "send half of it to deon.xlm" refers to them:',
  'write it out in instruction ("Send 1 USDC to deon.xlm") using the amounts from the context.',
  'If you cannot work out what "it" is from the context, ask.',
  'Correct obvious typos when you write the instruction: "edge 5 USDC exposure" means "hedge 5 USDC exposure".',
  'Hedging an asset means moving that exposure into another asset. If the request says hedge or reduce exposure to something',
  'and does not say what to move into, ask one question for it and offer XLM as an example.',
  "For 'act', fill the reading fields. action is 'swap' whenever a trade is asked for, 'supply' when an asset already held goes into a lending pool with no trade, 'borrow' and 'repay' for loans, and 'offramp' for sending USDC already held to a bank.",
  "followOn is 'lend' ONLY when the user asks for the proceeds to be supplied, lent or put to work in a lending pool, and 'offramp' ONLY when they ask for the proceeds to go to their bank or to fiat.",
  'Joining two ASSETS with "and" is NOT a follow-on: "buy XLM and USDC" is one purchase of two things.',
  'Venue names are often misspelled. "Blende", "blnd" and "blend protocol" all mean Blend.',
  "Use followOnVenue 'blend' when Blend is named or clearly implied, 'defindex' when DeFindex is, 'moneygram' or 'testanchor' for those anchors, otherwise an empty string.",
  'amountStated is false when the user named no size; set amountUsd to 0 in that case.',
  'For anything other than act, leave the reading fields at their defaults.',
  'facts must never contain an account number or a person’s name.',
].join(' ')

/** Only where a bank cash-out exists; elsewhere naming it would promise what the chain lacks. */
const CASH_OUT_PROMPT = [
  'Cashing out to a bank is possible only to Nigerian naira (NGN), from XLM or USDC. If the user says off-ramp or cash out',
  'without an asset, ask which asset they are cashing out and say the payout is to naira.',
  'If they ask for another currency, ask whether they want naira instead.',
].join(' ')

function systemPrompt(chain: string): string {
  return chain === 'stellar' ? `${BASE_PROMPT} ${CASH_OUT_PROMPT}` : BASE_PROMPT
}

/** Long enough for any sentence a person types here, short enough to bound what is passed on. */
const MAX_INSTRUCTION_CHARS = 400

/** A run of ten or more digits is an account number, or close enough to one to keep off a third party. */
const LONG_NUMBER = /\d{10,}/

/**
 * What a message is, or null when it could not be read.
 *
 * Null covers every failure — no key, a timeout, a refused request, a reply
 * with no tool call, an act that names an asset the app cannot trade. The
 * caller reports it; nothing is run.
 */
export async function orchestrateWithLlm(
  turns: OrchestrateTurn[],
  options: OrchestrateOptions = {}
): Promise<OrchestrateResult | null> {
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

  const asked = turns.filter((t) => t.role === 'assistant').length

  for (const model of models) {
    const result = await orchestrateWithModel(turns, options, model)
    if (result === null) continue
    // After four questions the user has said all they are going to. A fifth is
    // not asked; the request is reported as not pinned down rather than run.
    // The model's own last question becomes the reply, so even this ending is
    // in its words rather than a stock sentence.
    if (result.status === 'ask' && asked >= MAX_QUESTIONS) {
      return { status: 'unclear', reply: result.question }
    }
    return result
  }
  return null
}

async function orchestrateWithModel(
  turns: OrchestrateTurn[],
  options: OrchestrateOptions,
  config: IntentModel
): Promise<OrchestrateResult | null> {
  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS)

  const context = (options.context ?? []).filter((l) => l.trim() !== '').slice(0, 6)
  const chain = options.chain ?? 'stellar'
  const facts = `${systemPrompt(chain)}\nWhat Intent does:\n${capabilitySheet(chain)}`
  const system =
    context.length === 0
      ? facts
      : `${facts}\nContext from earlier in this chat:\n${context.join('\n')}`

  let payload: unknown
  try {
    const res = await doFetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'system', content: system }, ...(options.history ?? []), ...turns],
        tools: [ORCHESTRATE_TOOL],
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

  return interpret(payload, options)
}

interface OrchestrateArguments extends ToolArguments {
  outcome?: unknown
  question?: unknown
  reply?: unknown
  instruction?: unknown
  facts?: unknown
  orderStyle?: unknown
  limitPriceUsd?: unknown
  amountOf?: unknown
}

function argumentsOf(payload: unknown): OrchestrateArguments | null {
  try {
    const choices = (payload as { choices?: { message?: { tool_calls?: unknown } }[] }).choices
    const calls = choices?.[0]?.message?.tool_calls
    if (!Array.isArray(calls) || calls.length === 0) return null
    const raw = (calls[0] as { function?: { arguments?: unknown } }).function?.arguments
    return typeof raw === 'string' ? (JSON.parse(raw) as OrchestrateArguments) : null
  } catch {
    return null
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** What the model said in plain words, when it did not call the tool. */
function plainContentOf(payload: unknown): string {
  try {
    const choices = (payload as { choices?: { message?: { content?: unknown } }[] }).choices
    const content = choices?.[0]?.message?.content
    return typeof content === 'string' ? content.trim().slice(0, 1500) : ''
  } catch {
    return ''
  }
}

function interpret(payload: unknown, options: OrchestrateOptions): OrchestrateResult | null {
  const args = argumentsOf(payload)
  if (args === null) {
    // A small model sometimes answers instead of calling the tool, most often to
    // a follow-up inside a conversation. That is a reply to the person, and it
    // can never run anything, so it is shown rather than reported as unreadable.
    const said = plainContentOf(payload)
    return said === '' ? null : { status: 'help', reply: said }
  }

  switch (args.outcome) {
    case 'help': {
      const reply = text(args.reply)
      return reply === '' ? { status: 'help' } : { status: 'help', reply }
    }

    case 'out_of_scope': {
      const reply = text(args.reply)
      return reply === '' ? { status: 'out_of_scope' } : { status: 'out_of_scope', reply }
    }

    case 'ask': {
      // The model sometimes puts the question in the reply field.
      const question = text(args.question) || text(args.reply)
      return question === '' ? null : { status: 'ask', question }
    }

    case 'act': {
      const reading = readingFromArguments(args, options)
      if (reading === null) return null

      // A trade with no size cannot be quoted, and the old reading filled one
      // in. Asked for instead.
      if (reading.action === 'swap' && !reading.amountStated) {
        return {
          status: 'ask',
          question:
            'How much would you like to trade? A dollar amount or an amount of the asset works.',
        }
      }

      const instruction = text(args.instruction).slice(0, MAX_INSTRUCTION_CHARS)
      // Without a usable sentence there is nothing to hand the agents.
      if (instruction === '') return null

      // The brief goes to third-party model providers, so anything that looks
      // like an account number is dropped here rather than left to the prompt.
      const context = (Array.isArray(args.facts) ? args.facts : [])
        .filter((f): f is string => typeof f === 'string')
        .map((f) => f.trim())
        .filter((f) => f !== '' && !LONG_NUMBER.test(f))
        .slice(0, 8)

      const style = ORDER_STYLES.find((known) => known === args.orderStyle) ?? 'market'
      const amountOf = AMOUNT_OF.find((known) => known === args.amountOf)
      const limit =
        typeof args.limitPriceUsd === 'number' &&
        Number.isFinite(args.limitPriceUsd) &&
        args.limitPriceUsd > 0
          ? args.limitPriceUsd
          : undefined

      return {
        status: 'act',
        reading,
        style,
        ...(amountOf !== undefined ? { amountOf } : {}),
        ...(style === 'limit' && limit !== undefined ? { limitPriceUsd: limit } : {}),
        instruction,
        context,
      }
    }

    default:
      return null
  }
}
