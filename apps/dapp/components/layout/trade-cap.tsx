'use client'

import { createContext, useContext, type ReactNode } from 'react'

import { tradeCapNote } from '../../lib/trade-cap-copy'

const TradeCapContext = createContext<number | undefined>(undefined)

/** Carries the server-decided mainnet cap to any screen that wants to say it. */
export function TradeCapProvider({
  capUsd,
  children,
}: {
  capUsd: number | undefined
  children: ReactNode
}): JSX.Element {
  return <TradeCapContext.Provider value={capUsd}>{children}</TradeCapContext.Provider>
}

/** One quiet line under a trade input. Renders nothing where there is no cap. */
export function TradeCapNote(): JSX.Element | null {
  const note = tradeCapNote(useContext(TradeCapContext))
  return note === undefined ? null : <p className="text-muted-foreground mt-2 text-xs">{note}</p>
}
