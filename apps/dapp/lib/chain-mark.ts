const DRAWN = ['arc', 'stellar', 'solana', 'avalanche', 'sui', 'monad', 'near'] as const

export type DrawnChain = (typeof DRAWN)[number]

export type ChainBadge = { kind: 'mark'; chain: DrawnChain } | { kind: 'file'; slug: string }

/** A chain a venue names, as the shared drawn mark or else its file under /images/chains. */
export function chainMarkFor(chain: string): ChainBadge {
  const slug = chain
    .toLowerCase()
    .replace(/\s*chain$/, '')
    .trim()
  const drawn = DRAWN.find((c) => c === slug)
  return drawn !== undefined ? { kind: 'mark', chain: drawn } : { kind: 'file', slug }
}
