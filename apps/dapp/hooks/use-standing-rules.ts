'use client'

import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useChain } from '../providers/chain-provider'
import { useWallet } from './use-wallet'
import { evaluateTrigger } from '../lib/standing-intent'
import type { StandingIntent } from '../lib/standing-intent'
import {
  cancelRule,
  clearRules,
  loadRules,
  markFired,
  reportDue,
  saveRule,
  syncRules,
  type StoredRule,
} from '../lib/standing-store'
import { toPriceTable } from '../lib/swap/price-types'
import { fetchMarketPricesFromRoute } from '../lib/swap/prices-client'

/**
 * Watching standing rules against live prices, from the tab.
 *
 * The tab is no longer the only watcher. A scheduled tick on the server
 * evaluates every armed rule against the same prices, emails the owner when
 * one fires, and files it in the inbox for their next visit. This hook still
 * watches while the page is open, for the reason it always did: someone
 * looking at the page should see a rule come due the moment it does, not a
 * minute later by email.
 *
 * Two watchers judging the same rules is only safe because they report to the
 * same record. A rule that comes due here is reported to the server at once,
 * so the tick finds it already fired and does not prompt a second time. And
 * the local list is refilled from the server on every visit, so a rule the
 * tick fired while no tab was open shows up as fired here.
 *
 * **A fired trigger is not a trade.** This hook decides that a condition has
 * been met and hands that decision to the caller. It never signs anything: the
 * user approves each firing in their wallet, so a rule cannot spend money
 * while nobody is looking. The server-side watcher holds no key and has the
 * same limit. Moving to autonomous execution means pre-signed transactions,
 * which is a separate and much larger security question.
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
  /** Re-reads the server's copy, e.g. after the inbox reports a firing. */
  refresh: () => void
}

export function useStandingRules(): StandingRules {
  const { slug } = useChain()
  const { address } = useWallet()
  const [rules, setRules] = useState<StoredRule[]>([])
  const [due, setDue] = useState<DueRule[]>([])
  // Rules already reported to the server as due, so a price refresh does not
  // report the same firing again while the user is deciding.
  const reported = useRef(new Set<string>())

  // Same source the agents and the confirm card use, so a rule is judged
  // against the number the rest of the app shows.
  const { data: prices } = useQuery({
    queryKey: ['market-prices'],
    queryFn: async () => toPriceTable(await fetchMarketPricesFromRoute()),
    refetchInterval: CHECK_INTERVAL_MS,
    staleTime: 30_000,
  })

  const readLocal = useCallback(() => {
    setRules(loadRules(slug))
  }, [slug])

  // Local copy first, so the panel paints at once; then the server's, which
  // is the record. Re-run when the wallet connects, because the list is
  // scoped to it.
  const refresh = useCallback(() => {
    readLocal()
    let stale = false
    void syncRules(slug, address).then((synced) => {
      if (!stale) setRules(synced)
    })
    return () => {
      stale = true
    }
  }, [slug, address, readLocal])

  useEffect(() => refresh(), [refresh])

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
      if (!verdict.fires) continue

      fired.push({ rule, at: now.toISOString() })

      if (!reported.current.has(rule.id)) {
        reported.current.add(rule.id)
        const price = rule.trigger.kind === 'schedule' ? undefined : prices[rule.trigger.asset]
        reportDue(rule.id, price, now)
      }
    }
    setDue(fired)
  }, [rules, prices])

  const add = useCallback(
    (rule: StandingIntent) => {
      saveRule(rule, address ?? '')
      readLocal()
    },
    [address, readLocal]
  )

  const cancel = useCallback(
    (id: string) => {
      cancelRule(id)
      readLocal()
    },
    [readLocal]
  )

  const clear = useCallback(() => {
    clearRules(slug)
    readLocal()
  }, [slug, readLocal])

  const recordFired = useCallback(
    (id: string, txHash: string) => {
      markFired(id, txHash)
      readLocal()
    },
    [readLocal]
  )

  return {
    rules,
    due,
    prices: prices ?? {},
    add,
    cancel,
    clear,
    recordFired,
    refresh: () => void refresh(),
  }
}
