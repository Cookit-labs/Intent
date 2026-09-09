'use client'

import type { CreateIntentInput, Intent } from '@intent/types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { getIntentClient } from '../lib/sdk'
import { useIntentStore } from '../stores/intent.store'

const client = getIntentClient()

export const intentKeys = {
  all: ['intents'] as const,
  // Keyed by chain so switching networks refetches rather than showing the
  // previous chain's cached list.
  forChain: (chain: string) => ['intents', { chain }] as const,
  detail: (id: string) => ['intents', id] as const,
}

function isLive(intent?: Intent): boolean {
  return (
    intent != null &&
    intent.status !== 'settled' &&
    intent.status !== 'failed' &&
    intent.status !== 'cancelled'
  )
}

export function useIntents(chain?: string) {
  const setIntents = useIntentStore((s) => s.setIntents)
  return useQuery({
    queryKey: chain === undefined ? intentKeys.all : intentKeys.forChain(chain),
    queryFn: async () => {
      const data = await client.intents.list(chain)
      setIntents(data)
      return data
    },
  })
}

export function useIntent(id: string) {
  return useQuery({
    queryKey: intentKeys.detail(id),
    queryFn: () => client.intents.get(id),
    // Poll while the intent is still progressing so the lifecycle animates.
    refetchInterval: (query) => (isLive(query.state.data) ? 1500 : false),
  })
}

export function useCreateIntent() {
  const queryClient = useQueryClient()
  const addIntent = useIntentStore((s) => s.addIntent)

  return useMutation({
    mutationFn: (input: CreateIntentInput) => client.intents.create(input),
    onSuccess: (created) => {
      addIntent(created)
      queryClient.invalidateQueries({ queryKey: intentKeys.all })
      queryClient.setQueryData(intentKeys.detail(created.id), created)
    },
  })
}
