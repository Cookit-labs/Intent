'use client'

import { useQuery } from '@tanstack/react-query'
import { stellarNetwork } from '@intent/config'

import {
  activityRecords,
  fetchActivity,
  hasActivityRecord,
  mergeHistory,
  withPayouts,
} from '../lib/chains/activity'
import { syncTurns } from '../lib/chat-history'
import { cashoutRecords, fetchCashouts } from '../lib/naira/history'
import { fetchSwapHistory, type SwapRecord } from '../lib/swap/history'
import type { WeaveOrderView } from '../lib/weave/orders'
import { useChain } from '../providers/chain-provider'
import { useWallet } from './use-wallet'

async function fetchCashoutOrders(): Promise<WeaveOrderView[]> {
  try {
    const res = await fetch('/api/cashout/orders')
    if (!res.ok) return []
    const body = (await res.json()) as { orders?: WeaveOrderView[] }
    return Array.isArray(body.orders) ? body.orders : []
  } catch {
    return []
  }
}

export interface WalletHistory {
  /** False on a chain nothing is recorded for. */
  supported: boolean
  rows: SwapRecord[]
  loading: boolean
  /** A read failed, so the rows may be incomplete and an empty list means nothing. */
  unread: boolean
  /** Every read answered. Only then does an empty list mean this wallet has done nothing here. */
  settled: boolean
}

/**
 * Everything this wallet has done on the page's chain, on every chain the same way.
 *
 * Stellar's ledger stays the first source there, since it holds trades made outside this app and
 * reads richer rows. The app's own record fills in what it doesn't list as a swap, a Blend supply for
 * one, and is the whole list on every other chain.
 */
export function useWalletHistory(): WalletHistory {
  const { address, isConnected } = useWallet()
  const { slug } = useChain()
  const supported = hasActivityRecord(slug)
  const stellar = slug === 'stellar'
  const ready = supported && isConnected && address !== undefined

  // A bundle's steps and the words behind a row live in the conversation, which lives on the
  // server. Pulled before the rows render so a cleared browser still names them.
  useQuery({
    queryKey: ['turn-sync', slug, address],
    queryFn: () => syncTurns(slug),
    enabled: ready,
    staleTime: 30_000,
  })

  const ledger = useQuery({
    queryKey: ['swap-history', slug, address],
    queryFn: () => fetchSwapHistory(address as string),
    enabled: ready && stellar,
    // Settled trades do not change, so this only needs to catch new ones.
    staleTime: 30_000,
    // A trade made moments ago in the Compose tab must be here when the user
    // switches to History. Without this the cached list is served untouched and
    // the newest trade appears to be missing.
    refetchOnMount: 'always',
  })

  const activity = useQuery({
    queryKey: ['chain-activity', slug, address],
    queryFn: () => fetchActivity(slug, address as string),
    enabled: ready,
    staleTime: 30_000,
    refetchOnMount: 'always',
  })

  // Cash-outs are the app's own record, not the ledger's: a payout is a plain
  // payment to a one-time address that no longer exists, so the chain cannot
  // say what it was. A failed or empty list leaves the rows as they were.
  const naira = useQuery({
    queryKey: ['cashouts', slug, address],
    queryFn: () => fetchCashouts(address as string),
    enabled: ready && stellar,
    staleTime: 30_000,
    refetchOnMount: 'always',
  })
  const orders = useQuery({
    queryKey: ['cashout-orders', address],
    queryFn: fetchCashoutOrders,
    enabled: ready,
    staleTime: 30_000,
    refetchOnMount: 'always',
  })

  const primary = stellar
    ? mergeHistory(
        ledger.data ?? [],
        cashoutRecords(naira.data ?? [], stellarNetwork.blockExplorerUrl)
      )
    : []
  const recorded = withPayouts(activityRecords(activity.data ?? [], slug), orders.data ?? [], slug)
  const rows = mergeHistory(primary, recorded)

  const reads = stellar ? [ledger, activity] : [activity]
  return {
    supported,
    rows,
    // Whichever answers first is shown: one slow source shouldn't hide what another already has.
    loading: rows.length === 0 && reads.some((read) => read.isLoading),
    unread: reads.some((read) => read.isError),
    settled: ready && reads.every((read) => read.isSuccess),
  }
}
