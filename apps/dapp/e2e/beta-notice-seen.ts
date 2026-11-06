import { BETA_RELEASE } from '../lib/chain-beta'

/**
 * Browser storage with the beta notice already seen on every beta chain, or it would sit over each
 * page these specs test. `beta-chain.spec.ts` starts without this to test the notice itself.
 */
export const BETA_NOTICE_SEEN = [
  {
    origin: 'http://localhost:3006',
    localStorage: ['solana', 'avalanche', 'sui', 'monad', 'near'].map((slug) => ({
      name: `intent-beta-notice:${BETA_RELEASE}:${slug}`,
      value: '1',
    })),
  },
]
