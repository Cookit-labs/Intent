'use client'

import { readBalanceList } from '../../lib/chat/balance-lines'
import { TokenIcon } from '../ui/token-icon'

/** What an agent said. A wallet balance is drawn as rows with each asset's logo; anything else is text. */
export function AgentText({ text }: { text: string }): JSX.Element {
  const list = readBalanceList(text)
  if (list === undefined) return <>{text}</>
  return (
    <span className="flex flex-col gap-2 whitespace-normal">
      <span>Your wallet holds:</span>
      <span className="flex flex-col gap-1.5">
        {list.rows.map((row, i) => (
          <span key={`${row.symbol}-${row.id ?? ''}-${i}`} className="flex items-center gap-2.5">
            <TokenIcon symbol={row.symbol} size={22} unknown={row.id !== undefined} />
            <span className="font-semibold tabular-nums">{row.amount}</span>
            <span className="opacity-70">{row.symbol}</span>
            {row.id !== undefined ? <span className="text-xs opacity-60">{row.id}</span> : null}
          </span>
        ))}
      </span>
      {list.after.map((line) => (
        <span key={line} className="text-xs opacity-70">
          {line}
        </span>
      ))}
    </span>
  )
}
