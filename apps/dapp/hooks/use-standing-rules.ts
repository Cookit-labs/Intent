'use client'

import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'

import { useChain } from '../providers/chain-provider'
import { evaluateTrigger } from '../lib/standing-intent'
import type { StandingIntent } from '../lib/standing-intent'
import {
  cancelRule,
  clearRules,
  loadRules,
  markFired,
  saveRule,
  type StoredRule,
} from '../lib/standing-store'
import { toPriceTable } from '../lib/swap/price-types'
import { fetchMarketPricesFromRoute } from '../lib/swap/prices-client'

/**
 * Watching standing rules against live prices.
 *
 * The watcher is a browser tab, and the app says so rather than implying
 * otherwise. A rule fires when this is open and the condition is met; close
 * the tab and nothing is watching. That is a real limitation and hiding it
 * would be worse than the limitation itself — someone who believes a rule is
 * running will not check back.
 *
 * **A fired trigger is not a trade.** This hook decides that a condition has
 * been met and hands that decision to the caller. It never signs anything: the
 * user approves each firing in their wallet, so a rule cannot spend money
 * while nobody is looking. Moving to autonomous execution means pre-signed
 * transactions, which is a separate and much larger security question.
 */

/** How often to re-check. Prices move slowly enough that a minute is plenty. */
const CHECK_INTERVAL_MS = 60_000

export interface DueRule {
  rule: StoredRule
  /** Why it is due, for the prompt shown to the user. */
  at: string
}

export interface StandingRules {
  rules: StoredRule[]
  /** Rules whose condition is met right now and are waiting on a signature. */
  due: DueRule[]
  /** Current prices the rules are being judged against. */
  prices: Record<string, number>
  add: (rule: StandingIntent) => void
  cancel: (id: string) => void
  clear: () => void
  /** Records that a rule executed, with the transaction that proves it. */
  recordFired: (id: string, txHash: string) => void
  /** True while a browser tab is doing the watching, which is always today. */
  watchedLocally: boolean
}

export function useStandingRules(): StandingRules {
  const { slug } = useChain()
  const [rules, setRules] = useState<StoredRule[]>([])
  const [due, setDue] = useState<DueRule[]>([])

  // Same source the agents and the confirm card use, so a rule is judged
  // against the number the rest of the app shows.
  const { data: prices } = useQuery({
    queryKey: ['market-prices'],
    queryFn: async () => toPriceTable(await fetchMarketPricesFromRoute()),
    refetchInterval: CHECK_INTERVAL_MS,
    staleTime: 30_000,
  })

  const refresh = useCallback(() => {
    setRules(loadRules(slug))
  }, [slug])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Re-evaluated whenever prices move or the rule set changes, rather than on
  // a timer of its own: a rule can only become due when one of those changes,
  // and polling independently would just check the same answer repeatedly.
  useEffect(() => {
    if (prices === undefined) return

    const now = new Date()
    const fired: DueRule[] = []
    for (const rule of rules) {
      if (rule.status !== 'armed') continue
      const verdict = evaluateTrigger(rule, prices, now)
      if (verdict.fires) fired.push({ rule, at: now.toISOString() })
    }
    setDue(fired)
  }, [rules, prices])

  const add = useCallback(
    (rule: StandingIntent) => {
      saveRule(rule)
      refresh()
    },
    [refresh]
  )

  const cancel = useCallback(
    (id: string) => {
      cancelRule(id)
      refresh()
    },
    [refresh]
  )

  const clear = useCallback(() => {
    clearRules(slug)
    refresh()
  }, [slug, refresh])

  const recordFired = useCallback(
    (id: string, txHash: string) => {
      markFired(id, txHash)
      refresh()
    },
    [refresh]
  )

  return {
    rules,
    due,
    prices: prices ?? {},
    add,
    cancel,
    clear,
    recordFired,
    // Stated plainly and surfaced in the UI. When a server-side watcher
    // exists this becomes false and the wording changes with it.
    watchedLocally: true,
  }
}
