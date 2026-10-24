import { createAvatar } from '@dicebear/core'
import * as pixelArt from '@dicebear/pixel-art'

/**
 * A game character for an agent, drawn from its key.
 *
 * Derived rather than assigned, like the colour: the same model is the same
 * character in every race, history row and deploy, and a new model gets one
 * without anyone drawing it. Drawn locally, so no avatar request leaves the page.
 */

/** FNV-1a, 32-bit. Shared with the gradient and the bank marks. */
export function keyHash(key: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/** Brand purple tints, so a line-up reads as one set. */
const BACKDROPS = ['c9cbf5', 'e2e3fa', 'd9dbfa', 'b6b9f0', 'dcd6f7', 'cfd8f6']

const cache = new Map<string, string>()

/** The character as a data URI, ready for an `<img>`. */
export function agentAvatarUri(key: string): string {
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const uri = createAvatar(pixelArt, {
    seed: key,
    backgroundColor: [BACKDROPS[keyHash(key) % BACKDROPS.length] as string],
  }).toDataUri()
  cache.set(key, uri)
  return uri
}
