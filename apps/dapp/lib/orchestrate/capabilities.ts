import { chainModule } from '../chains/registry'
import type { ChainActionKind } from '../chains/types'

/**
 * What Intent does, written down once.
 *
 * The orchestrator answers questions about the app from this sheet and from
 * nothing else. A model left to describe a product from its own idea of one will
 * promise features it lacks, so every claim it may make about Intent is here,
 * and the prompt forbids the rest.
 *
 * Server only: it reads the chains' venues, and whether a chain has any can turn
 * on a secret. Its one importer is the orchestrator, which only an API route runs.
 */

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

const NOTHING_RUNS = 'Nothing can be swapped, supplied or staked on this chain right now.'

function bullets(lines: string[]): string {
  return lines.map((l) => `- ${l}`).join('\n')
}

/** The facts about Intent that apply on a chain, one per line. */
export function capabilitySheet(chain: string): string {
  if (chain === 'stellar') {
    return bullets([SWAP_RACED, ...COMMON, ...STELLAR_ONLY])
  }
  const venues = chainModule(chain)?.venues
  if (venues === undefined) return `- ${SWAP_DIRECT}`

  // Off Stellar only what the chain's own venues can do is claimed: accumulate,
  // hedge and send are Stellar's, and the chat reads only swap, supply and stake.
  // A race needs a venue that can quote, so a kind with none is never promised one.
  const offered = (kind: ChainActionKind): boolean => venues.some((v) => v.kinds.includes(kind))
  const raced = (kind: ChainActionKind): boolean =>
    venues.some((v) => v.kinds.includes(kind) && v.quote !== undefined)
  const lines: string[] = []
  if (offered('swap')) lines.push(raced('swap') ? SWAP_RACED_OFF_STELLAR : SWAP_DIRECT)
  if (offered('supply')) {
    lines.push(
      `Supply: put an asset you hold into a lending or earn venue to earn yield. ${raced('supply') ? 'Agents compete to propose the best venue; you' : 'You'} review it and sign in your wallet.`
    )
  }
  if (offered('stake')) {
    lines.push(
      `Stake: stake an asset for a staking token. ${raced('stake') ? 'Agents compete to propose the best venue; you' : 'You'} review it and sign in your wallet.`
    )
  }
  return bullets(lines.length > 0 ? lines : [NOTHING_RUNS])
}
