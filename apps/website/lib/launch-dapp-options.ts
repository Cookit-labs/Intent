/**
 * The Launch dApp menu's options, derived from the dApp origin at build time.
 *
 * Deliberately no fallback origin. A default like `http://localhost:3001`
 * names a port, not an app — any other project started first owns that port,
 * and the Arc option would hand visitors someone else's site with no visible
 * error. Unset means "not configured": both options render disabled, with a
 * label written for the visitor. The variable's name belongs in the console
 * warning the component prints for whoever deploys the site, never in the
 * menu a visitor reads.
 */
export type ChainOptionId = 'arc' | 'stellar' | 'solana' | 'avalanche'

export interface ChainOption {
  chain: ChainOptionId
  name: string
  tagline: string
  href: string | null
}

export const UNAVAILABLE = 'Not available yet'
/** For the chains that are planned and not built. Never a link, whatever the origin. */
export const COMING_SOON = 'Coming soon'

/**
 * Both chains deep-link into the dApp's chain segment (`/arc/...`,
 * `/stellar/...`) so the choice made here survives the navigation — landing on
 * the dApp root would just bounce the visitor to the default chain.
 */
export function chainOptions(dappUrl: string | undefined): ChainOption[] {
  const origin = (dappUrl ?? '').trim().replace(/\/+$/, '')
  const configured = origin !== ''
  return [
    {
      chain: 'arc',
      name: 'Arc',
      tagline: configured ? 'Arc testnet · live' : UNAVAILABLE,
      href: configured ? `${origin}/arc/intents` : null,
    },
    {
      chain: 'stellar',
      name: 'Stellar',
      tagline: configured ? 'Stellar testnet · live' : UNAVAILABLE,
      href: configured ? `${origin}/stellar/intents` : null,
    },
    { chain: 'solana', name: 'Solana', tagline: COMING_SOON, href: null },
    { chain: 'avalanche', name: 'Avalanche', tagline: COMING_SOON, href: null },
  ]
}
