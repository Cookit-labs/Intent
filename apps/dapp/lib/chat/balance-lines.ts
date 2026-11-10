/**
 * Reads a balance reply back into rows, so the chat can draw each asset with its logo.
 *
 * The reply is saved as text, in history too, so it is read from the text rather than carried
 * beside it: a balance asked for last week gets its logos the same as one asked for now.
 */

const HEADER = 'Your wallet holds:'
const ROW = /^• ([\d,]+(?:\.\d+)?) (\S+)(?: \((.+)\))?$/

export interface BalanceRow {
  amount: string
  symbol: string
  /** A short id, for a token this chain doesn't list, so two of one name can be told apart. */
  id?: string
}

export interface BalanceList {
  rows: BalanceRow[]
  /** Lines after the list: "and 3 more", or why some tokens are not shown. */
  after: string[]
}

export function readBalanceList(text: string): BalanceList | undefined {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== HEADER) return undefined
  const rows: BalanceRow[] = []
  let i = 1
  for (; i < lines.length; i++) {
    const match = ROW.exec((lines[i] ?? '').trim())
    if (match === null) break
    const [, amount = '', symbol = '', id] = match
    rows.push(id === undefined ? { amount, symbol } : { amount, symbol, id })
  }
  if (rows.length === 0) return undefined
  const after = lines
    .slice(i)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return { rows, after }
}
