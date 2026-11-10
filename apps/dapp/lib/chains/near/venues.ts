import type { Venue } from '@intent/types'
import { rheaDexListing, rheaLendListing } from './rhea-listing'

const NEAR = ['NEAR']

/**
 * The NEAR table from the integration report, in its order. Only what can be
 * prepared and signed through this app says `executes`; every other row is listed.
 * Rhea Lend runs because it is the only way to borrow on NEAR, and its card says what its
 * April 2026 exploit means. 1Click into Linq stays listed because a failed bank
 * payout has no clean refund path.
 */
export const nearVenues: Venue[] = [
  {
    id: 'weave-near',
    name: 'Weave',
    family: 'near',
    category: 'offramp',
    chains: ['NEAR'],
    bestFor: 'Cashing out USDC to a bank or mobile money in naira, shillings and more',
    url: 'https://paywithweave.com',
    integration: 'executes',
    capability:
      'Cash out USDC to a bank or mobile money account in Nigeria, Kenya, Uganda or Tanzania. Weave bridges the USDC to Base and pays out through Paycrest, and the receipt shows what it actually paid. Every deposit is checked before you sign.',
  },
  {
    id: '1click',
    family: 'near',
    name: 'NEAR Intents 1Click',
    category: 'swap',
    chains: NEAR,
    bestFor: 'Most of the volume on NEAR, priced by competing market makers',
    url: 'https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api',
    integration: 'executes',
    capability:
      'Swaps NEAR, USDC and USDT inside your NEAR account. Your wallet signs a transfer to a one-time deposit address. Mainnet only. No swap has been signed through this app yet.',
  },
  {
    id: 'near-linq-cashout',
    family: 'near',
    name: '1Click into Linq',
    category: 'offramp',
    chains: NEAR,
    bestFor: 'A route from NEAR USDC to naira, untested end to end',
    url: 'https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api',
  },
  rheaDexListing,
  {
    id: 'rhea-limit',
    family: 'near',
    name: 'Rhea',
    category: 'orderbook',
    chains: NEAR,
    bestFor: 'Selling or buying NEAR at a price you name, until it fills or you cancel it',
    url: 'https://rhea.finance',
    integration: 'executes',
    capability:
      'Places, reads, cancels and collects NEAR orders against USDC, and checks every transaction before you sign. What fills waits on Rhea until you collect it. Mainnet only. No order has been signed through this app yet.',
  },
  {
    id: 'rnear',
    family: 'near',
    name: 'rNEAR',
    category: 'staking',
    chains: NEAR,
    bestFor: 'Liquid staking from Rhea, with most supply sitting in Rhea Lend',
    url: 'https://rhea.finance',
    integration: 'executes',
    capability:
      'Stakes NEAR for rNEAR on lst.rhealab.near, showing the rate Rhea publishes, and unstakes it with a wait and then a claim. Mainnet only. Nothing has been signed through this app yet.',
  },
  {
    id: 'linear',
    family: 'near',
    name: 'LiNEAR',
    category: 'staking',
    chains: NEAR,
    bestFor: 'Liquid staking spread across hundreds of NEAR validators',
    url: 'https://linearprotocol.org',
    integration: 'executes',
    capability:
      'Stakes NEAR for LiNEAR on linear-protocol.near and unstakes it with a wait of 4 epochs and then a claim. Mainnet only. Nothing has been signed through this app yet.',
  },
  {
    id: '1click-earn',
    family: 'near',
    name: '1Click Earn',
    category: 'savings',
    chains: NEAR,
    bestFor: 'A vault on Base reached by quote, stacking bridge and vault risk',
    url: 'https://docs.near-intents.org/integration/distribution-channels/1click-api/earn',
    integration: 'executes',
    capability:
      'Puts USDC or USDT into Gauntlet USDC Prime on Base, held in your NEAR Intents balance. Quotes start around $20. Taking it out sells the share back into your NEAR Intents balance, then a claim pays you. Mainnet only. No deposit has been signed through this app yet.',
  },
  rheaLendListing,
  {
    id: 'metapool',
    family: 'near',
    name: 'Meta Pool',
    category: 'staking',
    chains: NEAR,
    bestFor: 'Liquid staking with stNEAR across many validators, from 1 NEAR',
    url: 'https://metapool.app',
    integration: 'executes',
    capability:
      'Stakes NEAR for stNEAR on meta-pool.near, from 1 NEAR, and unstakes it with a wait and then a claim. Mainnet only. Nothing has been signed through this app yet.',
  },
  {
    id: 'near-agent-api',
    family: 'near',
    name: 'NEAR Intents Agent API',
    category: 'infrastructure',
    chains: NEAR,
    bestFor: 'Wallets for agents with spending limits, enforced off-chain and with no audit found',
    url: 'https://docs.agentsonintents.com/integration/agent-api/overview',
  },
  {
    id: 'near-ai-cloud',
    family: 'near',
    name: 'NEAR AI Cloud',
    category: 'infrastructure',
    chains: NEAR,
    bestFor: 'Private AI inference in secure hardware, on its higher privacy tiers',
    url: 'https://docs.near.ai/cloud/quickstart',
  },
  {
    id: 'near-chain-signatures',
    family: 'near',
    name: 'Chain Signatures',
    category: 'infrastructure',
    chains: NEAR,
    bestFor: 'Signing for other chains from a NEAR account. Gas on the other chain is still needed',
    url: 'https://docs.near.org/chain-abstraction/chain-signatures/getting-started',
  },
  {
    id: 'near-confidential-swaps',
    family: 'near',
    name: 'Confidential swaps',
    category: 'swap',
    chains: NEAR,
    bestFor: 'A privacy option on 1Click quotes, not yet checked against its originator terms',
    url: 'https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/confidential-swaps',
  },
  {
    id: 'near-agent-market',
    family: 'near',
    name: 'NEAR AI Agent Market',
    category: 'payments',
    chains: NEAR,
    bestFor: 'Hiring agents and paying per job, with fees not stated on its docs landing page',
    url: 'https://docs.market.near.ai',
  },
  {
    id: 'near-trezu-sputnik',
    family: 'near',
    name: 'Trezu and Sputnik DAO',
    category: 'savings',
    chains: NEAR,
    bestFor: 'Multisig treasuries that a savings group could share',
    url: 'https://github.com/NEAR-DevHub/trezu',
  },
  {
    id: 'near-hyperliquid',
    family: 'near',
    name: 'Hyperliquid via 1Click',
    category: 'perps',
    chains: NEAR,
    bestFor: 'Funding Hyperliquid perps from NEAR. Needs a separate EVM key to trade',
    url: 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes',
  },
]
