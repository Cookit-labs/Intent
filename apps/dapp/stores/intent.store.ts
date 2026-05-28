import { create } from 'zustand'
import type { Intent } from '@intent/types'

interface IntentStore {
  intents: Intent[]
  selectedIntentId: string | null
  setIntents: (intents: Intent[]) => void
  selectIntent: (id: string | null) => void
  addIntent: (intent: Intent) => void
  updateIntent: (id: string, updates: Partial<Intent>) => void
}

export const useIntentStore = create<IntentStore>((set) => ({
  intents: [],
  selectedIntentId: null,
  setIntents: (intents) => set({ intents }),
  selectIntent: (id) => set({ selectedIntentId: id }),
  addIntent: (intent) => set((s) => ({ intents: [intent, ...s.intents] })),
  updateIntent: (id, updates) =>
    set((s) => ({ intents: s.intents.map((i) => (i.id === id ? { ...i, ...updates } : i)) })),
}))