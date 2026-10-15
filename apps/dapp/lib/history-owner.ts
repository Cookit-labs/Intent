/**
 * Whose history is in play.
 *
 * The conversation cache and the session token are both per-browser, so without
 * an owner a second wallet connected in the same browser reads the first
 * wallet's turns — including its withdrawals.
 */

let owner: string | undefined
const listeners = new Set<() => void>()

export function historyOwner(): string | undefined {
  return owner
}

export function setHistoryOwner(address: string | undefined): void {
  if (owner === address) return
  owner = address
  // Deferred: this is called while a component renders, and listeners set state.
  queueMicrotask(() => {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        /* a listener must not stop the others */
      }
    }
  })
}

export function onHistoryOwnerChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
