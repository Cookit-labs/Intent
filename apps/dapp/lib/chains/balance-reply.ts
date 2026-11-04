import type { TokenBalance, WalletBalances } from './types'

const MAX_LISTED = 30
const NOT_READ = "I could not read your balance just now, so I won't guess. Try again in a moment."

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id
}

function line(token: TokenBalance): string {
  if (token.listed || token.native) return `• ${token.amount} ${token.symbol}`
  return token.symbol === token.id
    ? `• ${token.amount} ${shortId(token.id)}`
    : `• ${token.amount} ${token.symbol} (${shortId(token.id)})`
}

function isZero(amount: string): boolean {
  return /^0(\.0*)?$/.test(amount)
}

export function chainBalanceReply(balances: WalletBalances | undefined, chainName: string): string {
  if (balances === undefined) return NOT_READ
  const held = balances.tokens.filter((t) => t.native || !isZero(t.amount))
  const ordered = [
    ...held.filter((t) => t.native),
    ...held.filter((t) => !t.native && t.listed),
    ...held.filter((t) => !t.native && !t.listed),
  ]
  const shown = ordered.slice(0, MAX_LISTED).map(line)
  const rest = ordered.length - shown.length
  const parts = ['Your wallet holds:', ...shown]
  if (rest > 0) parts.push(`and ${rest} more`)
  if (!balances.complete) parts.push(`Only tokens Intent knows on ${chainName} are shown.`)
  return parts.join(String.fromCharCode(10))
}
