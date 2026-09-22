import type { FollowOnAction } from './parse-compound'

/**
 * Reading an instruction by meaning rather than by matching its wording.
 *
 * The regex parser recognises surface forms, and people do not write in surface
 * forms. Measured against twelve ways of writing one instruction it understood
 * five, and the misses split evenly between two different gates: half failed
 * because no marker matched (a comma or a full stop joining the clauses), half
 * because the verb list lacked "stake", "start earning", "add it to", "move it
 * into". Patching either list closes those and fails on the next seven. The
 * tail of English is infinite and every widening costs accuracy on the other
 * side.
 *
 * So this asks a model instead, and the regex stays as the fallback. That
 * ordering matters: an unconfigured key, an outage, or a slow response must
 * leave the app exactly as capable as it was before this file existed, never
 * less. A parser that can fail closed is worse than a narrow one.
 *
 * **Measured before being trusted.** `deepseek-flash` read 10/10 of the
 * sentences that defeated the regex, held 13/14 stable across three runs, and
 * answered in a median 1.5s. Its one wobble was a dropped tool call on a
 * sentence the regex already handles — which is precisely what the fallback is
 * for. `deepseek-v4-pro` was slower (median 3.0s, max 7.8s), less accurate
 * (8/10), and returned malformed JSON once, so it is not used here.
 */

/** Fast and cheap. The parse is a small classification, not a reasoning task. */
const PARSE_MODEL = 'deepseek-flash'

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'

/**
 * Long enough for a slow response, short enough that a hung call does not
 * outlast a user's patience. The fallback runs the moment this expires, so the
 * cost of being wrong here is one wasted second, not a failure.
 */
const TIMEOUT_MS = 6_000

/** Reasoning tokens count against this, so it is not as generous as it looks. */
const MAX_OUTPUT_TOKENS = 700

/**
 * What the model is asked to fill in.
 *
 * Deliberately smaller than `ParsedIntent`. The model answers only what needs
 * judgement — which assets, how much, and whether a follow-on was asked for —
 * and everything derived (prices, escrow, base units, deadlines) stays with the
 * existing deterministic code. A model asked to compute is a model inventing
 * numbers.
 */
const READ_INTENT_TOOL = {
  type: 'function',
  function: {
    name: 'read_intent',
    description: 'Read a trading instruction into structured form.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['swap', 'supply', 'borrow', 'repay', 'offramp'],
          description:
            "What the user wants done. 'swap' trades one asset for another. 'supply' puts an asset the account ALREADY HOLDS into a lending pool, with no trade at all — as in \"supply my XLM to Blend\". 'borrow' takes an asset OUT of a lending pool as a loan against collateral already posted — as in \"borrow wBTC against my position\". 'repay' pays a loan back. Use 'supply' whenever no trade is asked for. 'offramp' sends USDC the account ALREADY HOLDS to the user's bank through an anchor, with no trade — as in \"withdraw 5 USDC to my bank\" or \"cash out my USDC\". On an 'offramp', tokenIn and tokenOut are both USDC.",
        },
        tokenIn: {
          type: 'string',
          description:
            "Ticker of the asset leaving the account, e.g. USDC. On a 'supply', this is the asset being supplied.",
        },
        tokenOut: {
          type: 'string',
          description:
            "Ticker of the asset arriving, e.g. XLM. On a 'supply' nothing arrives, so repeat the supplied asset here.",
        },
        amountUsd: {
          type: 'number',
          description: 'Size in US dollars. Use 0 when the user named no size.',
        },
        amountIsUsd: {
          type: 'boolean',
          description:
            'True when the size was given in dollars ("$20 worth of XLM"). False when it counts the asset itself ("20 XLM"). These are different amounts and confusing them moves the wrong sum.',
        },
        amountStated: {
          type: 'boolean',
          description: 'False when the user named no size at all.',
        },
        followOn: {
          type: 'string',
          enum: ['none', 'lend', 'offramp'],
          description:
            'What happens to the proceeds after the trade. "none" almost always. "lend" supplies them to a lending pool. "offramp" withdraws them to the user\'s bank through an anchor — only when the user asks for the dollars, their bank, cash out, or fiat.',
        },
        followOnVenue: {
          type: 'string',
          description:
            'The lending venue when followOn is lend (e.g. blend), or the anchor when followOn is offramp (moneygram or testanchor). Empty when none was named.',
        },
      },
      // Every property required, matching the discipline the proposal schema
      // already uses: an omitted field is indistinguishable from a deliberate
      // "none", and strict tool schemas admit no optional properties.
      required: [
        'action',
        'tokenIn',
        'tokenOut',
        'amountUsd',
        'amountIsUsd',
        'amountStated',
        'followOn',
        'followOnVenue',
      ],
    },
  },
}

/**
 * The instruction that decides the hard case.
 *
 * The distinction worth spelling out is "and" joining two assets against "and"
 * joining a trade to a lending action. That single ambiguity is what the regex
 * could never resolve, and stating it explicitly is what makes the model get it
 * right rather than guessing from the conjunction.
 */
const SYSTEM_PROMPT = [
  "Read the user's instruction. Call read_intent exactly once.",
  "action is 'borrow' when the user asks to take a loan against collateral, and 'repay'",
  'when they ask to pay one back. Both name the asset borrowed or repaid in tokenIn.',
  "action is 'supply' when the user wants an asset they ALREADY HOLD put into a lending",
  'pool and asks for no trade at all: "supply my XLM to Blend", "lend 500 XLM".',
  "action is 'swap' whenever a trade is asked for, including a trade whose proceeds are",
  'then supplied — those use followOn instead.',
  'Venue names are often misspelled. "Blende", "blnd" and "blend protocol" all mean Blend.',
  "followOn is 'lend' ONLY when the user asks for the proceeds to be supplied, lent,",
  'deposited, staked, or put to work in a lending pool.',
  "followOn is 'offramp' ONLY when the user asks for the proceeds to go to their bank, to",
  "fiat, to dollars, or to be cashed out. 'Send it to my friend' is not an offramp.",
  "Use followOnVenue 'moneygram' when MoneyGram is named, 'testanchor' when the test anchor is,",
  'otherwise an empty string.',
  'Joining two ASSETS with "and" is NOT a follow-on: "buy XLM and USDC" is one purchase',
  'of two things, and its followOn is none.',
  'amountStated is false when the user named no size; set amountUsd to 0 in that case.',
  "Use followOnVenue 'blend' when Blend is named or clearly implied, otherwise an empty string.",
].join(' ')

export interface LlmReadIntent {
  /**
   * What the user wants done.
   *
   * 'supply' means an asset the account already holds goes into a lending
   * pool, with no trade at all. Without this field the model had no way to
   * express that, so "supply my XLM to Blend" could only be reported as a
   * swap — and was executed as one.
   */
  /**
   * What the user wants done.
   *
   * 'borrow' and 'repay' arrived last, deliberately: nothing should be able to
   * *say* borrow until the machinery underneath could do it safely. They are
   * the only two that can cost the user money after the transaction settles.
   */
  action: 'swap' | 'supply' | 'borrow' | 'repay' | 'offramp'
  tokenIn: string
  tokenOut: string
  /** Zero when the user named no size; check `amountStated` before using it. */
  amountUsd: number
  amountStated: boolean
  /**
   * Whether the size counts dollars or the asset itself.
   *
   * "$20 worth of XLM" and "20 XLM" differ by roughly a hundredfold at
   * today's price, so the unit has to travel with the number.
   */
  amountIsUsd: boolean
  followOn: FollowOnAction | null
}

export interface ReadIntentOptions {
  apiKey?: string
  baseUrl?: string
  model?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Tickers the app can actually trade. A symbol outside this is refused. */
  allowedSymbols?: string[]
  /** Lending venues that exist on this chain. */
  allowedVenues?: string[]
  /** Anchors that withdraw to fiat on this chain. Empty means none. */
  allowedAnchors?: string[]
}

interface ToolArguments {
  action?: unknown
  amountIsUsd?: unknown
  tokenIn?: unknown
  tokenOut?: unknown
  amountUsd?: unknown
  amountStated?: unknown
  followOn?: unknown
  followOnVenue?: unknown
}

/** Whether a parse can even be attempted. */
export function isLlmParseConfigured(options: ReadIntentOptions = {}): boolean {
  const key = options.apiKey ?? process.env['DEEPSEEK_API_KEY']
  return key !== undefined && key !== ''
}

/**
 * Reads an instruction, or returns null so the caller falls back.
 *
 * Null is never an error the user sees. Every failure path — no key, a timeout,
 * a refused request, a reply with no tool call, a symbol the app cannot trade —
 * returns null, and the regex parser answers instead. That is the whole safety
 * argument for putting a model in front of the parser at all.
 */
export async function readIntentWithLlm(
  text: string,
  options: ReadIntentOptions = {}
): Promise<LlmReadIntent | null> {
  const apiKey = options.apiKey ?? process.env['DEEPSEEK_API_KEY']
  if (apiKey === undefined || apiKey === '') return null

  const baseUrl = options.baseUrl ?? process.env['DEEPSEEK_BASE_URL'] ?? DEFAULT_BASE_URL
  const model = options.model ?? PARSE_MODEL
  const doFetch = options.fetchImpl ?? fetch

  // Abandoned rather than awaited indefinitely. A parse that arrives after the
  // user has given up is worth nothing, and the fallback is already correct.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS)

  let payload: unknown
  try {
    const res = await doFetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        tools: [READ_INTENT_TOOL],
        // 'auto' rather than forced, matching the agent brain: DeepSeek's
        // thinking mode rejects a forced tool_choice outright.
        tool_choice: 'auto',
        // Zero, unlike the agents. Those are asked to differ from one another;
        // a parser asked the same question twice should answer the same way.
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: controller.signal,
    })

    if (!res.ok) return null
    payload = await res.json()
  } catch {
    // A timeout, an abort, an unreachable host, malformed JSON. All the same
    // outcome: the caller falls back.
    return null
  } finally {
    clearTimeout(timer)
  }

  return interpret(payload, options)
}

/** Pulls the tool call out of a response, and refuses anything unusable. */
function interpret(payload: unknown, options: ReadIntentOptions): LlmReadIntent | null {
  const args = toolArgumentsOf(payload)
  if (args === null) return null

  // Anything unrecognised falls back to a swap rather than to a lending
  // action. A malformed reply must not silently open a liability.
  const ACTIONS = ['swap', 'supply', 'borrow', 'repay', 'offramp'] as const
  const action = ACTIONS.find((known) => known === args.action) ?? 'swap'

  const tokenIn = symbolOf(args.tokenIn, options.allowedSymbols)
  const tokenOut = symbolOf(args.tokenOut, options.allowedSymbols)
  if (tokenIn === undefined || tokenOut === undefined) return null
  // A swap of an asset for itself is meaningless. A *supply* names one asset
  // twice by design, so the check applies only to trades.
  // A swap of an asset for itself is meaningless. Supply, borrow and repay all
  // name one asset twice by design.
  if (action === 'swap' && tokenIn === tokenOut) return null

  const amountStated = args.amountStated === true
  const amountUsd =
    typeof args.amountUsd === 'number' && Number.isFinite(args.amountUsd) ? args.amountUsd : 0
  // A size that was claimed but is not a usable number is a contradiction, and
  // trading on it would size the trade wrong rather than not at all.
  if (amountStated && amountUsd <= 0) return null

  return {
    action,
    tokenIn,
    tokenOut,
    amountUsd: amountStated ? amountUsd : 0,
    amountStated,
    amountIsUsd: args.amountIsUsd === true,
    followOn: followOnOf(args, options.allowedVenues, options.allowedAnchors),
  }
}

function toolArgumentsOf(payload: unknown): ToolArguments | null {
  try {
    const choices = (payload as { choices?: { message?: { tool_calls?: unknown } }[] }).choices
    const calls = choices?.[0]?.message?.tool_calls
    if (!Array.isArray(calls) || calls.length === 0) return null

    const raw = (calls[0] as { function?: { arguments?: unknown } }).function?.arguments
    if (typeof raw !== 'string') return null

    return JSON.parse(raw) as ToolArguments
  } catch {
    return null
  }
}

/**
 * A ticker the app can actually trade, or nothing.
 *
 * Checked rather than trusted. A model naming an asset that does not exist here
 * would otherwise reach the quoter as a real instruction, and the app has one
 * ticker-impersonation trap in its history already.
 */
function symbolOf(value: unknown, allowed: string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const symbol = value.trim().toUpperCase()
  if (symbol === '') return undefined
  if (allowed === undefined || allowed.length === 0) return symbol
  return allowed.includes(symbol) ? symbol : undefined
}

/**
 * The follow-on, when one was asked for and this chain can perform it.
 *
 * A venue the app does not integrate returns nothing rather than being
 * substituted with one it does. Silently supplying somewhere the user did not
 * name is the worst possible reading of an explicit instruction.
 */
function followOnOf(
  args: ToolArguments,
  allowedVenues: string[] | undefined,
  allowedAnchors: string[] | undefined
): FollowOnAction | null {
  const named =
    typeof args.followOnVenue === 'string' ? args.followOnVenue.trim().toLowerCase() : ''

  if (args.followOn === 'offramp') {
    const anchors = allowedAnchors ?? []
    if (anchors.length === 0) return null
    if (named === '') {
      const first = anchors[0]
      return first === undefined ? null : { kind: 'offramp', venue: first }
    }
    return anchors.includes(named) ? { kind: 'offramp', venue: named } : null
  }

  if (args.followOn !== 'lend') return null
  const venues = allowedVenues ?? ['blend']
  if (venues.length === 0) return null

  // An unnamed venue defaults to the only one integrated, which is how "supply
  // it" without a venue has always been read.
  if (named === '') {
    const only = venues[0]
    return only === undefined ? null : { kind: 'lend', venue: only }
  }

  return venues.includes(named) ? { kind: 'lend', venue: named } : null
}
