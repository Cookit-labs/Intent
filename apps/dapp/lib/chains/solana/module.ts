import { canIssueOneClick, oneClickOriginVenue } from '../oneclick-origin'
import type { ChainModule, ChainVenue } from '../types'
import { readSolanaBalances } from './balances'
import { createJupiterLendVenue } from './jupiter-lend'
import { createJupiterSwapVenue } from './jupiter-swap'
import { createKaminoVenue } from './kamino'
import { createLuloVenue } from './lulo'
import { createPriceSource } from './price'
import { createSolanaSubmit } from './submit'
import { SOLANA_TOKENS } from './tokens'

const priceUsd = createPriceSource()

/** Inside the chain submit route's 60 seconds, leaving room to answer. Weave's route has its own. */
const SUBMIT_DEADLINE_MS = 50_000

export function buildSolanaVenues(
  env: Record<string, string | undefined> = process.env
): ChainVenue[] {
  const luloKey = env['LULO_API_KEY']?.trim()
  return [
    createJupiterSwapVenue({ priceUsd, env }),
    ...(canIssueOneClick(env) ? [oneClickOriginVenue('solana')] : []),
    createJupiterLendVenue({ env }),
    createKaminoVenue(),
    ...(luloKey ? [createLuloVenue({ apiKey: luloKey })] : []),
  ]
}

export const solanaModule: ChainModule = {
  chain: 'solana',
  tokens: SOLANA_TOKENS,
  venues: buildSolanaVenues(),
  defaultVenue: { swap: 'jupiter', supply: 'jupiter-lend' },
  priceUsd,
  submit: createSolanaSubmit({ deadlineMs: SUBMIT_DEADLINE_MS }),
  balances: readSolanaBalances,
}
