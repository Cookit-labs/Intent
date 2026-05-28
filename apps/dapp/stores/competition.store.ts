import { create } from 'zustand'
import type { Competition } from '@intent/types'

interface CompetitionStore {
  competitions: Competition[]
  activeCompetitionId: string | null
  setCompetitions: (c: Competition[]) => void
  setActiveCompetition: (id: string | null) => void
  updateCompetition: (id: string, updates: Partial<Competition>) => void
}

export const useCompetitionStore = create<CompetitionStore>((set) => ({
  competitions: [],
  activeCompetitionId: null,
  setCompetitions: (competitions) => set({ competitions }),
  setActiveCompetition: (id) => set({ activeCompetitionId: id }),
  updateCompetition: (id, updates) =>
    set((s) => ({
      competitions: s.competitions.map((c) => (c.id === id ? { ...c, ...updates } : c)),
    })),
}))