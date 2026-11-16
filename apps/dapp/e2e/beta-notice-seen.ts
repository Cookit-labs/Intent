import { BETA_RELEASE } from '../lib/chain-beta'

/**
 * Browser storage with the beta notice already seen on every beta chain, and the help button's
 * first-visit note too, or they would sit over each page these specs test. `beta-chain.spec.ts`
 * starts without this to test both.
 */
export const BETA_NOTICE_SEEN = [
  {
    origin: 'http://localhost:3006',
    localStorage: [
      ...['solana', 'avalanche', 'sui', 'monad', 'near'].map((slug) => ({
        name: `intent-beta-notice:${BETA_RELEASE}:${slug}`,
        value: '1',
      })),
      { name: 'intent:help-intro-seen', value: '1' },
    ],
  },
]
