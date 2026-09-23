'use client'

import { useQuery } from '@tanstack/react-query'
import { useCallback } from 'react'

import { useChain } from '../providers/chain-provider'
import { listInboxRemote, markInboxSeenRemote } from '../lib/api/standing-client'
import type { StandingRuleRecord } from '../lib/api/standing-client'

/**
 * Rules that fired while nobody was looking.
 *
 * The in-app half of "notify both ways". The tick emails the owner when a
 * rule fires; this is the same firing, shown on their next visit, with the
 * rule ready to sign. An email can be missed or read somewhere with no
 * wallet, and a rule that fired and went unnoticed is the same as one that
 * never fired.
 *
 * Polled on the same interval the tick runs at, so a firing found while this
 * page is open in another tab shows up here within a minute.
 */

/** How often to look. Matches the tick, which is how often anything can change. */
const POLL_INTERVAL_MS = 60_000

export interface StandingInbox {
  /** Fired rules the user has not looked at, newest firing first. */
  items: StandingRuleRecord[]
  /** True once the first read has answered, so a link into a rule can wait for it. */
  loaded: boolean
  /** Records that the user has looked at these. They leave the list on the next read. */
  markSeen: (ids: string[]) => void
}

export function useStandingInbox(): StandingInbox {
  const { slug } = useChain()

  const { data, isFetched, refetch } = useQuery({
    queryKey: ['standing-inbox', slug],
    queryFn: () => listInboxRemote(slug),
    refetchInterval: POLL_INTERVAL_MS,
    staleTime: 30_000,
  })

  const markSeen = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return
      void markInboxSeenRemote(ids)
        .catch((e: unknown) => {
          // Not fatal: the item stays in the inbox and is marked next time.
          // eslint-disable-next-line no-console
          console.warn('[standing] inbox items were not marked seen:', e)
        })
        .then(() => refetch())
    },
    [refetch]
  )

  return { items: data ?? [], loaded: isFetched, markSeen }
}
