import { canIssueOneClick, oneClickOriginVenue } from '../oneclick-origin'
import { createSendVenue, SEND_VENUE_ID } from '../send'
import type { ChainModule, ChainVenue } from '../types'
import { readSolanaBalances } from './balances'
import { createJitoVenue } from './jito'
import { createJupiterLendVenue } from './jupiter-lend'
import { createJupiterSwapVenue } from './jupiter-swap'
import { createKaminoVenue } from './kamino'
import { createKaminoLimitVenue, limoBook } from './limo'
import { createKaminoLendVenue } from './kamino-lend'
import { createLuloVenue } from './lulo'
import { createMarinadeVenue } from './marinade'
import { createPriceSource } from './price'
import { createRaydiumSwapVenue } from './raydium-swap'
import { createTitanSwapVenue } from './titan-swap'
import { createSolayerVenue } from './solayer'
import { createStreamflowVenue } from './streamflow'
import { createSolanaSubmit } from './submit'
import { SOLANA_TOKENS } from './tokens'

const priceUsd = createPriceSource()

/** Inside the chain submit route's 60 seconds, leaving room to answer. Weave's route has its own. */
const SUBMIT_DEADLINE_MS = 50_000

export function buildSolanaVenues(
  env: Record<string, string | undefined> = process.env
): ChainVenue[] {
  const luloKey = env['LULO_API_KEY']?.trim()
  const titanKey = env['TITAN_API_KEY']?.trim()
  return [
    createJupiterSwapVenue({ priceUsd, env }),
    createRaydiumSwapVenue({ priceUsd }),
    ...(titanKey ? [createTitanSwapVenue({ apiKey: titanKey, priceUsd })] : []),
    ...(canIssueOneClick(env) ? [oneClickOriginVenue('solana')] : []),
    createJupiterLendVenue({ env }),
    // After Earn, so "supply on Kamino" stays the vault it has always meant.
    createKaminoVenue(),
    createKaminoLimitVenue(),
    createKaminoLendVenue({ env }),
    ...(luloKey ? [createLuloVenue({ apiKey: luloKey })] : []),
    createJitoVenue({ env }),
    createMarinadeVenue({ env }),
    createSolayerVenue({ env }),
    ...(canIssueOneClick(env) ? [createStreamflowVenue()] : []),
    ...(canIssueOneClick(env) ? [createSendVenue('solana')] : []),
  ]
}

export const solanaModule: ChainModule = {
  chain: 'solana',
  tokens: SOLANA_TOKENS,
  venues: buildSolanaVenues(),
  defaultVenue: {
    swap: 'jupiter',
    supply: 'jupiter-lend',
    withdraw: 'jupiter-lend',
    borrow: 'kamino-lend',
    repay: 'kamino-lend',
    stake: 'jito',
    unstake: 'jito',
    claim: 'solayer',
    stream: 'streamflow',
    cancel: 'streamflow',
    send: SEND_VENUE_ID,
    limit: 'kamino-limit',
  },
  venueForToken: { unstake: { MSOL: 'marinade', JITOSOL: 'jito', SSOL: 'solayer' } },
  priceUsd,
  submit: createSolanaSubmit({ deadlineMs: SUBMIT_DEADLINE_MS }),
  balances: readSolanaBalances,
  limitBook: limoBook(),
}
