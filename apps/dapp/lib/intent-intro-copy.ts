import type { ChainSlug } from '@intent/types'

/** The line under "Submit an intent", naming the chain the user will actually settle on. */
export function intentIntro(chain: ChainSlug): string {
  const settle = chain === 'arc' ? 'you settle in USDC on Arc' : 'you sign and settle on Stellar'
  return `Declare the outcome you want. Autonomous agents compete to beat it — ${settle}.`
}
