'use client'

import { ChainMark } from '@intent/ui'
import type { ReactNode } from 'react'

import { useChain } from '../../providers/chain-provider'

/** The chain's logo with a figure over a label, set like the chat's identity beside it. */
export function CoinStat({
  figure,
  label,
  title,
}: {
  figure: string
  label: ReactNode
  title: string
}): JSX.Element {
  const { slug } = useChain()
  return (
    <div className="flex items-center gap-2.5" title={title}>
      <ChainMark chain={slug} className="text-foreground h-6 w-6 shrink-0" />
      <div className="flex flex-col leading-tight">
        <span className="text-foreground text-sm font-semibold tabular-nums">{figure}</span>
        <span className="text-muted-foreground whitespace-nowrap text-[11px] tabular-nums">
          {label}
        </span>
      </div>
    </div>
  )
}
