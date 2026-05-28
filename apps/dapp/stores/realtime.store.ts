import { create } from 'zustand'

type WSStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

interface RealtimeStore {
  status: WSStatus
  lastEventAt: string | null
  setStatus: (status: WSStatus) => void
  setLastEventAt: (at: string) => void
}

export const useRealtimeStore = create<RealtimeStore>((set) => ({
  status: 'disconnected',
  lastEventAt: null,
  setStatus: (status) => set({ status }),
  setLastEventAt: (at) => set({ lastEventAt: at }),
}))