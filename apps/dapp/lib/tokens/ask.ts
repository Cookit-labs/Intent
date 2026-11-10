/** Client-safe: whether a typed message asks about tokens, so the chat can bring up their card. */

export type TokenAsk = { kind: 'list' } | { kind: 'token'; query: string }

const ABOUT_THE_WALLET =
  /\b(?:my|mine|i have|i hold|i own|do i|wallet|balance|send|swap|buy|sell)\b/

const LIST_SHAPES = [
  /^(?:(?:can|could|would) you |please )?(?:show|list|give|get|see|find|display)(?: me)?(?: (?:a|the|all|all the))? ?(?:list of )?(?:\w+ )?(?:tokens|coins|assets)\b/,
  /^(?:(?:a|the) )?(?:\w+ )?(?:token|coin|asset) list\b/,
  /^list of (?:\w+ )?(?:tokens|coins|assets)\b/,
  /^(?:what|which) (?:\w+ )?(?:tokens|coins|assets)\b/,
  /^(?:tokens|coins|assets) (?:on|in|available|supported|listed)\b/,
]

const WORD = String.raw`([a-z$][a-z0-9.$_-]{0,19})`
const FIGURES = String.raw`(?:market ?cap|mcap|liquidity|holders?|(?:trading )?volume|fdv|token ?(?:info|data|stats)|stats|data|info)`

const TOKEN_SHAPES = [
  new RegExp(String.raw`^is ${WORD}(?: token| coin)? (?:verified|legit|real|safe)$`),
  new RegExp(
    String.raw`^(?:what(?:'s| is) )?(?:the )?${FIGURES}(?: and \w+(?: \w+)?)? (?:of|for|on) (?:the )?${WORD}(?: token| coin)?$`
  ),
  new RegExp(
    String.raw`^(?:how many )?holders (?:does|of|for) ${WORD}(?: token| coin)?(?: have)?$`
  ),
  new RegExp(String.raw`^${WORD}(?:'s)?(?: token| coin)? ${FIGURES}$`),
  new RegExp(
    String.raw`^(?:(?:can you )?(?:tell me|show me|give me) )?(?:about|info(?:rmation)? (?:on|about|for)|details? (?:on|about|for)|data (?:on|about|for)) (?:the )?${WORD}(?: token| coin)?$`
  ),
  new RegExp(String.raw`^(?:check|look up|lookup) (?:the )?${WORD} (?:token|coin)$`),
]

/** Words a shape could catch that name no token. */
const NOT_A_TOKEN = new Set(['this', 'that', 'it', 'the', 'a', 'an', 'these', 'those', 'tokens'])

function clean(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/[?.!\s]+$/, '')
    .replace(/^(?:hey|hi|ok|okay|so)[, ]+/, '')
    .replace(/^please /, '')
}

/** A message asking to see tokens or one token's figures, or nothing. Never moves anything. */
export function asksAboutTokens(text: string): TokenAsk | null {
  const said = clean(text)
  if (/\d/.test(said) || said.length > 80) return null
  if (!ABOUT_THE_WALLET.test(said) && LIST_SHAPES.some((shape) => shape.test(said))) {
    return { kind: 'list' }
  }
  for (const shape of TOKEN_SHAPES) {
    const query = shape.exec(said)?.[1]?.replace(/^\$/, '')
    if (query !== undefined && !NOT_A_TOKEN.has(query)) return { kind: 'token', query }
  }
  return null
}
