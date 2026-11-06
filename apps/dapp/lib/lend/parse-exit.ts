/**
 * "Withdraw 25 XLM", read before any model sees it.
 *
 * On Stellar a typed message goes to the orchestrator, whose fact sheet lists no
 * withdrawal, and whose instructions say to tell someone plainly when Intent does
 * not do a thing. So the person asking for their own money back was told it could
 * not be done. Getting out should not depend on a model answering either, so the
 * plain forms are read here and go straight to a card to sign.
 *
 * A strict shape, as money moves on what this returns. Anything else, and
 * anything naming a bank, falls through to whatever reads the message next.
 */

export type StellarExit =
  /** `amount` is plain decimal text. Absent means all of it. */
  | { kind: 'withdraw'; symbol: string; amount?: string }
  | { kind: 'repay'; symbol: string; amount?: string }
  /** No asset named: "take my money out of Blend". The reply says what is there. */
  | { kind: 'where' }

const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)`
const TOKEN = String.raw`([a-z][a-z0-9]{1,11})`
const WHOLE = String.raw`(?:all(?: of)?(?: my)?|everything(?: of my)?|my(?: whole| entire)?)`
const BLEND = String.raw`(?:blend(?: capital| pool| protocol)?|the blend pool|the pool)`
const PLEASE = String.raw`^(?:please )?`
const FROM = String.raw`(?: (?:from|out of) (?:my )?${BLEND})?`
const END = String.raw`(?: please)?$`
const WITHDRAW_VERB = String.raw`(?:withdraw|redeem|take out|pull out|remove)`
const REPAY_VERB = String.raw`(?:repay|pay back|pay off)`
const LOAN = String.raw`(?: loan| debt)?`
const ON_BLEND = String.raw`(?: (?:on|to|in) (?:my )?${BLEND})?`

const SOME_OUT = new RegExp(`${PLEASE}${WITHDRAW_VERB} ${AMOUNT} ?${TOKEN}${FROM}${END}`)
const ALL_OUT = new RegExp(`${PLEASE}${WITHDRAW_VERB} ${WHOLE} ${TOKEN}${FROM}${END}`)
const SOME_OUT_OF = new RegExp(
  `${PLEASE}(?:take|pull|get|move) ${AMOUNT} ?${TOKEN} (?:back )?out of (?:my )?${BLEND}${END}`
)
const ALL_OUT_OF = new RegExp(
  `${PLEASE}(?:take|pull|get|move) ${WHOLE} ${TOKEN} (?:back )?out of (?:my )?${BLEND}${END}`
)
const SOME_BACK = new RegExp(`${PLEASE}${REPAY_VERB} ${AMOUNT} ?${TOKEN}${LOAN}${ON_BLEND}${END}`)
const ALL_BACK = new RegExp(`${PLEASE}${REPAY_VERB} ${WHOLE} ${TOKEN}${LOAN}${ON_BLEND}${END}`)
const WHERE = new RegExp(
  `${PLEASE}(?:(?:withdraw|take out|pull out)(?: (?:my|all my)(?: money| funds| position)?)? (?:from|out of) (?:my )?${BLEND}|(?:take|get|pull|move) (?:my|all my) (?:money|funds|position) (?:back )?out of (?:my )?${BLEND}|close my (?:position in |${BLEND} position)|${REPAY_VERB} (?:all|everything|my (?:whole |entire )?(?:loan|loans|debt|debts)))${END}`
)

/** Words for money rather than a token: "withdraw 5 dollars" is a cash-out, not a pool withdrawal. */
const NOT_A_TOKEN = new Set([
  'usd',
  'dollar',
  'dollars',
  'naira',
  'ngn',
  'money',
  'funds',
  'cash',
  'position',
  'it',
  'that',
])

const TOKEN_WORDS: Record<string, string> = { lumen: 'XLM', lumens: 'XLM', stellar: 'XLM' }

function symbolOf(word: string): string | undefined {
  if (NOT_A_TOKEN.has(word)) return undefined
  return TOKEN_WORDS[word] ?? word.toUpperCase()
}

function plain(amount: string): string | undefined {
  const text = amount.replace(/,/g, '')
  return /[1-9]/.test(text) ? (text.startsWith('.') ? `0${text}` : text) : undefined
}

export function parseStellarExit(text: string): StellarExit | null {
  const clean = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/ ?[.!]+$/, '')

  if (WHERE.test(clean)) return { kind: 'where' }

  const read = (
    kind: 'withdraw' | 'repay',
    some: RegExp,
    all: RegExp
  ): StellarExit | null | undefined => {
    const part = some.exec(clean)
    if (part !== null) {
      const symbol = symbolOf(part[2] ?? '')
      const amount = plain(part[1] ?? '')
      return symbol === undefined || amount === undefined ? null : { kind, symbol, amount }
    }
    const whole = all.exec(clean)
    if (whole !== null) {
      const symbol = symbolOf(whole[1] ?? '')
      return symbol === undefined ? null : { kind, symbol }
    }
    return undefined
  }

  return (
    read('withdraw', SOME_OUT, ALL_OUT) ??
    read('withdraw', SOME_OUT_OF, ALL_OUT_OF) ??
    read('repay', SOME_BACK, ALL_BACK) ??
    null
  )
}

/** What a person has in Blend, said back, when they asked for their money and named no asset. */
export function whereReply(positions: {
  supplied: { display: string; symbol: string }[]
  collateral: { display: string; symbol: string }[]
  borrowed: { display: string; symbol: string }[]
}): string {
  const figure = (b: { display: string; symbol: string }): string =>
    `${Number(b.display)} ${b.symbol}`
  const held = [
    ...positions.supplied.map((b) => `${figure(b)} supplied`),
    ...positions.collateral.map((b) => `${figure(b)} as collateral`),
  ]
  if (held.length === 0) return 'You have nothing in Blend to withdraw.'

  const first = positions.supplied[0] ?? positions.collateral[0]
  const owed =
    positions.borrowed.length > 0
      ? ` You also owe ${positions.borrowed.map(figure).join(' and ')}, and collateral backing that loan stays in the pool until it is repaid.`
      : ''
  return `You have ${held.join(' and ')} in Blend.${owed} Say "withdraw all ${first?.symbol ?? ''}" to take it out, or name an amount.`
}
