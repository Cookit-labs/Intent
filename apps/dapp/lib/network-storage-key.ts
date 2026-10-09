import { activeNetwork, isMultiNetwork } from '@intent/config'

/**
 * A browser storage key that belongs to one network.
 *
 * A wallet session and the token a server issues for it are proof on a
 * network, not on the address: the same account exists on both. With several
 * networks served each gets its own key, so what was proven on one is never
 * found, and never trusted, on the other. With one network the key is the
 * plain one it has always been, so existing sessions carry over.
 */
export function networkKey(base: string): string {
  return isMultiNetwork() ? `${base}.${activeNetwork()}` : base
}
