/**
 * What Intent does, written down once.
 *
 * The orchestrator answers questions about the app from this sheet and from
 * nothing else. A model left to describe a product from its own idea of one will
 * promise features it lacks, so every claim it may make about Intent is here,
 * and the prompt forbids the rest.
 */

const COMMON = [
  'Swap: trade one asset for another at the market price, or place a limit order at a price you name. Agents compete to propose the best route; you review it and sign in your wallet.',
  'Accumulate: spread the buying of an asset over time instead of all at once.',
  'Hedge or rebalance: move exposure from one asset into another.',
  'Send: send an asset such as USDC or XLM to another account or to a name like deon.xlm. You review it and sign in your wallet.',
]

const STELLAR_ONLY = [
  'Lend: put an asset you already hold into a lending pool (Blend, and DeFindex when available) to earn yield, with no trade.',
  'Borrow and repay: done from your position in the History tab, where you can see what it can support and the price at which it would be liquidated. Not run from the chat.',
  'Cash out: send USDC or XLM to a Nigerian bank account, paid in naira, through an anchor. A form collects the bank details. Mainnet only.',
  'Leveraged positions: open a long or short on an asset with leverage, for example "long XLM 10x with 50 USDC".',
  'Each trade is capped at $50 on mainnet.',
]

/** The facts about Intent that apply on a chain, one per line. */
export function capabilitySheet(chain: string): string {
  const lines = chain === 'stellar' ? [...COMMON, ...STELLAR_ONLY] : COMMON
  return lines.map((l) => `- ${l}`).join('\n')
}
