/**
 * A face for an agent, drawn from its key.
 *
 * Derived rather than assigned, like the colour: the same model gets the same
 * face in every race, history row and deploy, and a new model gets one without
 * anyone drawing it. Each feature reads a different slice of the hash, so two
 * agents that share a hue still differ in shape.
 */

export type PersonaHead = 'round' | 'square' | 'tall'
export type PersonaEyes = 'dots' | 'ovals' | 'visor' | 'cyclops' | 'happy'
export type PersonaMouth = 'smile' | 'flat' | 'o' | 'grin' | 'none'
export type PersonaAntenna = 'none' | 'ball' | 'twin' | 'spike'

export interface Persona {
  hue: number
  head: PersonaHead
  eyes: PersonaEyes
  mouth: PersonaMouth
  antenna: PersonaAntenna
  blush: boolean
}

const HEADS: readonly PersonaHead[] = ['round', 'square', 'tall']
const EYES: readonly PersonaEyes[] = ['dots', 'ovals', 'visor', 'cyclops', 'happy']
const MOUTHS: readonly PersonaMouth[] = ['smile', 'flat', 'o', 'grin', 'none']
const ANTENNAE: readonly PersonaAntenna[] = ['none', 'ball', 'twin', 'spike']

/** FNV-1a, 32-bit. Shared with the gradient so a face and its colour agree. */
export function keyHash(key: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

function pick<T>(list: readonly T[], hash: number, shift: number): T {
  return list[(hash >>> shift) % list.length] as T
}

export function agentPersona(key: string): Persona {
  const hash = keyHash(key)
  return {
    hue: hash % 360,
    head: pick(HEADS, hash, 9),
    eyes: pick(EYES, hash, 12),
    mouth: pick(MOUTHS, hash, 16),
    antenna: pick(ANTENNAE, hash, 20),
    blush: ((hash >>> 24) & 1) === 1,
  }
}
