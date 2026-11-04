import type { ChainSlug } from '@intent/types'

import { chainCapabilities } from '../chains/capabilities'

/**
 * What Intent does, written down once.
 *
 * The orchestrator answers questions about the app from this sheet and from
 * nothing else. A model left to describe a product from its own idea of one will
 * promise features it lacks, so every claim it may make about Intent is here,
 * and the prompt forbids the rest.
 */

/**
 * Chains where agents race to propose the route. A chain joins this list only
 * once its venues can be quoted, so the sheet never promises a race that does
 * not run.
 */
const AGENT_RACE_CHAINS = ['stellar', 'near', 'solana', 'sui']

const SWAP_RACED =
  'Swap: trade one asset for another at the market price, or place a limit order at a price you name. Agents compete to propose the best route; you review it and sign in your wallet.'
const SWAP_RACED_OFF_STELLAR =
  'Swap: trade one asset for another at the market price. Agents compete to propose the best route; you review it and sign in your wallet.'
const SWAP_DIRECT =
  'Swap: trade one asset for another at the market price. You review it and sign in your wallet.'

const COMMON = [
  'Accumulate: spread the buying of an asset over time instead of all at once.',
  'Hedge or rebalance: move exposure from one asset into another.',
  'Send: send an asset such as USDC or XLM to another account or to a name like deon.xlm. You review it and sign in your wallet.',
]

const STELLAR_ONLY = [
  'Lend: put an asset you already hold into a lending pool (Blend, and DeFindex when available) to earn yield, with no trade.',
  'Borrow and repay: done from your position in the History tab, where you can see what it can support and the price at which it would be liquidated. Not run from the chat.',
  'Cash out: send USDC or XLM to a Nigerian bank account, paid in naira, through an anchor. A form collects the bank details. Mainnet only.',
  'Leveraged positions: open a long or short on an asset with leverage, for example "long XLM 10x with 50 USDC".',
  'Each trade is capped at $500 on mainnet.',
]

/** The facts about Intent that apply on a chain, one per line. */
export function capabilitySheet(chain: string): string {
  // Limit orders are Stellar's; elsewhere a swap is at the market price.
  const swap =
    chain === 'stellar'
      ? SWAP_RACED
      : AGENT_RACE_CHAINS.includes(chain)
        ? SWAP_RACED_OFF_STELLAR
        : SWAP_DIRECT
  if (chain === 'stellar') {
    return [swap, ...COMMON, ...STELLAR_ONLY].map((l) => `- ${l}`).join('\n')
  }
  // Off Stellar only what the chain's own venues can do is claimed: accumulate,
  // hedge and send are Stellar's, and the chat reads only swap, supply and stake.
  const kinds = new Set((chainCapabilities(chain as ChainSlug) ?? []).map((c) => c.kind))
  const raced = AGENT_RACE_CHAINS.includes(chain)
  const lines = [swap]
  if (kinds.has('supply')) {
    lines.push(
      `Supply: put an asset you hold into a lending or earn venue to earn yield. ${raced ? 'Agents compete to propose the best venue; you' : 'You'} review it and sign in your wallet.`
    )
  }
  if (kinds.has('stake')) {
    lines.push(
      `Stake: stake an asset for a staking token. ${raced ? 'Agents compete to propose the best venue; you' : 'You'} review it and sign in your wallet.`
    )
  }
  return lines.map((l) => `- ${l}`).join('\n')
}
