import { activeNetwork, type StellarNetworkName } from '@intent/config'
import type { ChainDescriptor, Venue } from '@intent/types'

import { evmVenues } from './chains/evm/venues'
import { nearVenues } from './chains/near/venues'
import { solanaVenues } from './chains/solana/venues'
import { suiVenues } from './chains/sui/venues'
import { anchorsOn } from './offramp/anchors'

export const venues: Venue[] = [
  ...solanaVenues,
  ...suiVenues,
  ...nearVenues,
  ...evmVenues,
  {
    id: 'cow-swap',
    family: 'evm' as const,
    name: 'CoW Swap',
    category: 'aggregator',
    chains: ['Ethereum', 'Arbitrum', 'Base', 'Gnosis'],
    bestFor: 'Large trades, MEV-safe',
    url: 'https://swap.cow.fi',
  },
  {
    id: '1inch',
    family: 'evm' as const,
    name: '1inch',
    category: 'aggregator',
    chains: ['Ethereum', 'Arbitrum', 'Optimism', 'Polygon', 'Base'],
    bestFor: 'All-round multichain default',
    url: 'https://1inch.io',
  },
  {
    id: 'uniswap',
    family: 'evm' as const,
    name: 'Uniswap',
    category: 'swap',
    chains: ['Ethereum', 'Arbitrum', 'Optimism', 'Base', 'Polygon'],
    bestFor: 'Deep AMM liquidity',
    url: 'https://uniswap.org',
  },
  {
    id: 'curve',
    family: 'evm' as const,
    name: 'Curve',
    category: 'swap',
    chains: ['Ethereum', 'Arbitrum', 'Optimism', 'Polygon'],
    bestFor: 'Stablecoin pairs',
    url: 'https://curve.fi',
  },
  {
    id: '0x',
    family: 'evm' as const,
    name: '0x',
    category: 'aggregator',
    chains: ['Ethereum', 'Arbitrum', 'Base', 'Polygon'],
    bestFor: 'RFQ + swap API',
    url: 'https://0x.org',
  },
  {
    id: 'kyberswap',
    family: 'evm' as const,
    name: 'KyberSwap',
    category: 'aggregator',
    chains: ['Ethereum', 'Arbitrum', 'Optimism', 'Polygon', 'Base'],
    bestFor: 'Dynamic routing',
    url: 'https://kyberswap.com',
  },
  {
    id: 'matcha',
    family: 'evm' as const,
    name: 'Matcha',
    category: 'aggregator',
    chains: ['Ethereum', 'Arbitrum', 'Base', 'Polygon'],
    bestFor: 'Best-price discovery',
    url: 'https://matcha.xyz',
  },
  {
    id: 'dydx',
    family: 'evm' as const,
    name: 'dYdX',
    category: 'orderbook',
    chains: ['dYdX Chain'],
    bestFor: 'Order book, perps',
    url: 'https://dydx.exchange',
  },
  {
    id: 'injective',
    family: 'evm' as const,
    name: 'Injective',
    category: 'orderbook',
    chains: ['Injective'],
    bestFor: 'On-chain order book',
    url: 'https://injective.com',
  },
  // Stellar-native venues. These trade Stellar assets through Soroban/SDEX and
  // have no EVM deployment, which is exactly why the Apps screen filters by
  // chain family rather than listing everything everywhere.
  {
    id: 'soroswap',
    name: 'Soroswap',
    family: 'stellar' as const,
    category: 'swap',
    chains: ['Stellar'],
    bestFor: 'Soroban AMM swaps',
    url: 'https://soroswap.finance',
    integration: 'executes',
    networks: ['testnet', 'mainnet'],
    capability:
      'Swaps route through Soroswap’s Soroban router, priced live against the other venues.',
  },
  {
    // A different product from the AMM above, and listed apart from it on
    // purpose: the aggregator is Soroswap's hosted route-finder, splitting one
    // swap across Soroswap's pools, Aquarius's and the classic book, and
    // several of its routes originate from routers already on this page in
    // their own right.
    id: 'soroswap-aggregator',
    name: 'Soroswap Aggregator',
    family: 'stellar' as const,
    category: 'aggregator',
    chains: ['Stellar'],
    bestFor: 'One swap split across several venues',
    url: 'https://soroswap.finance',
    integration: 'executes',
    networks: ['testnet', 'mainnet'],
    capability:
      'One swap split across Soroswap, Aquarius and the classic DEX. Needs SOROSWAP_API_KEY; every transaction it returns is re-checked before signing.',
  },
  {
    id: 'aquarius',
    name: 'Aquarius',
    family: 'stellar' as const,
    category: 'swap',
    chains: ['Stellar'],
    bestFor: 'Incentivised AMM pools',
    url: 'https://aqua.network',
    integration: 'executes',
    networks: ['testnet', 'mainnet'],
    capability:
      'Swaps route through Aquarius’s router against the pool the agent chose, priced live against the other venues.',
  },
  {
    // Mainnet only: Phoenix has no standing testnet instance to quote
    // against, the mirror of Noether being testnet-only above. Each pair
    // has its own pool contract rather than one router, so the agent's
    // chosen pool travels on the quote and the builder signs only that one.
    id: 'phoenix',
    name: 'Phoenix',
    family: 'stellar' as const,
    category: 'swap',
    chains: ['Stellar'],
    bestFor: 'A second independent AMM to compare against Aquarius and Soroswap',
    url: 'https://phoenix-hub.io',
    integration: 'executes',
    networks: ['mainnet'],
    capability:
      'Swaps route through the exact Phoenix pool the agent chose, resolved from Phoenix’s factory for the pair.',
  },
  {
    id: 'stellarx',
    name: 'StellarX',
    family: 'stellar' as const,
    category: 'orderbook',
    chains: ['Stellar'],
    bestFor: 'Native SDEX orderbook',
    url: 'https://www.stellarx.com',
    integration: 'executes',
    networks: ['testnet', 'mainnet'],
    capability:
      'Swaps and resting limit orders settle on the network’s own order book, read and written directly.',
  },
  // The network's own API, not a venue. Listed because everything on Stellar
  // classic goes through it: balances and history are read from it, path
  // payments and orders are built against its order book, and every signed
  // transaction is submitted to it.
  {
    id: 'horizon',
    name: 'Stellar Horizon',
    family: 'stellar' as const,
    category: 'infrastructure',
    chains: ['Stellar'],
    bestFor: 'The network API the app reads and submits through',
    url: 'https://developers.stellar.org/docs/data/apis/horizon',
    integration: 'executes',
    networks: ['testnet', 'mainnet'],
    capability:
      'Account balances and history, the order book that classic swaps and resting orders fill against, and submission of every signed transaction.',
  },
  {
    id: 'etherfuse',
    name: 'Etherfuse',
    family: 'stellar' as const,
    category: 'rwa',
    chains: ['Stellar'],
    bestFor: 'Tokenized sovereign debt',
    url: 'https://etherfuse.com',
    integration: 'executes',
    networks: ['testnet', 'mainnet'],
    // A getter: which bonds exist depends on the network of the request.
    get capability(): string {
      return activeNetwork() === 'mainnet'
        ? 'Buy tokenized Mexican and US treasury bills (CETES, USTRY). They settle like any other classic asset, and getting out is selling them back for USDC on the network’s order book, at whatever that book pays then. No Etherfuse account needed.'
        : 'Buy tokenized Mexican, US and Korean treasury bills. They settle like any other classic asset.'
    },
  },
  {
    id: 'stellar-pools',
    name: 'Stellar Liquidity Pools',
    family: 'stellar' as const,
    category: 'pool',
    chains: ['Stellar'],
    bestFor: 'Fee income with no protocol risk',
    url: 'https://developers.stellar.org/docs/build/guides/liquidity-pools',
    integration: 'executes',
    networks: ['testnet', 'mainnet'],
    capability:
      'A share in a pool earns part of its 0.3% trading fee, and comes out in whatever mix the pool holds by then. Run by the network itself, with no contract to trust. Any share your wallet holds can be withdrawn from the History tab. Depositing is not offered from the chat.',
  },
  {
    id: 'blend',
    name: 'Blend Capital',
    family: 'stellar' as const,
    category: 'lending',
    chains: ['Stellar'],
    bestFor: 'Supply and borrow against collateral',
    url: 'https://blend.capital',
    integration: 'executes',
    networks: ['testnet', 'mainnet'],
    capability:
      'Rates are read live. Supply, withdraw, borrow, repay and collateral are signed here, by typing "withdraw 25 XLM" or from the History tab, and each is checked by the pool itself. A withdrawal waits if the pool has lent out too much of that asset. A position with a loan can be liquidated if its collateral falls.',
  },
  {
    id: 'defindex',
    name: 'DeFindex',
    family: 'stellar' as const,
    category: 'lending',
    chains: ['Stellar'],
    bestFor: 'Yield vaults that autocompound',
    url: 'https://defindex.io',
    // 'quotes', not 'executes', and deliberately so. The rate is read live
    // and offered to the agents, and the deposit path is built and checked
    // end to end — but against the API's documented shapes, with no key to
    // exercise them. 'executes' is a promise the app has not yet watched
    // itself keep. Flip it once a deposit has been signed against a live key.
    integration: 'quotes',
    capability:
      'Vault APYs are read live once DEFINDEX_API_KEY is set. Deposits are built by DeFindex’s API and checked here before signing; a key is still needed to verify that end to end.',
  },
  // A payout service, not a trading venue: the agents' venue list drops the
  // off-ramp category, and a payout is a follow-on the user fills in a form.
  {
    id: 'weave-stellar',
    name: 'Weave',
    family: 'stellar' as const,
    category: 'offramp',
    chains: ['Stellar'],
    bestFor: 'Cashing out USDC to a bank or mobile money in naira, shillings and more',
    url: 'https://paywithweave.com',
    integration: 'executes',
    networks: ['mainnet'],
    capability:
      'Cash out USDC to a bank or mobile money account in Nigeria, Kenya, Uganda or Tanzania. Weave bridges the USDC to Base and pays out through Paycrest, and the receipt shows what it actually paid. Every deposit is checked before you sign.',
  },
  {
    id: 'linq',
    name: 'Linq',
    family: 'stellar' as const,
    category: 'offramp',
    chains: ['Stellar'],
    bestFor: 'Cash out XLM or USDC to a Nigerian bank in naira',
    url: 'https://switch.uselinq.xyz',
    integration: 'executes',
    networks: ['mainnet'],
    capability:
      'Naira payouts to Nigerian bank accounts, paid out from USDC: XLM is swapped to USDC first. The holder is looked up from the bank, and the payment goes only to the deposit address of the order Linq made.',
  },
  {
    id: 'testanchor',
    name: 'SDF test anchor',
    family: 'stellar' as const,
    category: 'offramp',
    chains: ['Stellar'],
    bestFor: 'Withdrawing USDC to a (fake) bank on testnet',
    url: 'https://testanchor.stellar.org',
    integration: 'executes',
    capability:
      'SEP-24 withdrawal of USDC. The anchor handles verification and bank details; this app sends only the payment it names.',
  },
  {
    id: 'moneygram',
    name: 'MoneyGram Access',
    family: 'stellar' as const,
    category: 'offramp',
    chains: ['Stellar'],
    bestFor: 'Cash pickup at MoneyGram locations',
    url: 'https://stellar.moneygram.com',
    integration: 'executes',
    capability:
      'SEP-24 withdrawal of USDC on testnet. Production needs a commercial agreement with MoneyGram; the flow is the same.',
  },
  // Perpetual futures. `quotes`, not `executes`: the reads are live and the
  // order path is built, but the gateway mints the API key an order needs
  // only for wallets on its closed-beta allowlist (`beta-status` answered
  // `allowed: false` for every address tried on 2026-09-23), so no position
  // has been signed through this app end to end.
  {
    id: 'noether',
    beta: true,
    name: 'Noether',
    family: 'stellar' as const,
    category: 'perps',
    chains: ['Stellar'],
    bestFor: 'Leveraged longs and shorts, up to 10x',
    // The site answers; its `api.` and `docs.` subdomains do not resolve.
    url: 'https://noether.exchange',
    integration: 'quotes',
    capability:
      'Mark prices and open interest are read live, and “long XLM 10x with 50 USDC” prepares a position to sign. Signing needs an API key from its closed beta, so it is unverified end to end. Testnet-only here: its mainnet contracts are paused until its audit clears, and its gateway reports 0.0.0-dev.',
  },
  // A name service, not a trading venue. It earns its place because a send
  // to deon.xlm settles through what it resolves; the agents never see it.
  {
    id: 'sorobandomains',
    name: 'Soroban Domains',
    family: 'stellar' as const,
    category: 'names',
    chains: ['Stellar'],
    bestFor: 'Send to a .xlm name instead of an address',
    url: 'https://sorobandomains.org',
    integration: 'executes',
    networks: ['testnet', 'mainnet'],
    get capability(): string {
      return activeNetwork() === 'mainnet'
        ? 'Type deon.xlm as a recipient and the payment goes to the address the name resolves to, shown in full before you sign. Names and payments both live on Stellar mainnet.'
        : 'Type deon.xlm as a recipient and the payment goes to the address the name resolves to, shown in full before you sign. Names are read from the registry on Stellar mainnet; the payment settles here on testnet.'
    },
  },
]

const EVM_CHAINS_WITH_VENUES = ['Avalanche', 'Monad']

/**
 * Whether a venue belongs on this chain's lists. Family decides, except that EVM chains share one:
 * Avalanche and Monad list only the venues that name them, and a venue naming either one belongs
 * to that chain alone. Arc has no venues of its own, so it keeps the rest of the family's list.
 */
export function venueOnChain(
  venue: Pick<Venue, 'family' | 'chains'>,
  chain: Pick<ChainDescriptor, 'family' | 'name'>
): boolean {
  if (venue.family !== chain.family) return false
  if (chain.family !== 'evm') return true
  return EVM_CHAINS_WITH_VENUES.includes(chain.name)
    ? venue.chains.includes(chain.name)
    : !venue.chains.some((name) => EVM_CHAINS_WITH_VENUES.includes(name))
}

/**
 * Which venues exist on which network.
 *
 * A venue is wired in against testnet first; its mainnet contracts are a
 * separate act of verification, recorded in `networks`. Until then it is
 * testnet-only everywhere at once — the agents are not offered it, no quote
 * is asked of it, no builder will produce a transaction for it, and the Apps
 * page says so quietly. Absent `networks` means testnet only, because
 * claiming mainnet by omission is the wrong way round.
 */
export function venueNetworks(venue: Pick<Venue, 'networks'>): StellarNetworkName[] {
  return venue.networks ?? ['testnet']
}

export function isVenueOn(
  venue: Pick<Venue, 'networks'>,
  network: StellarNetworkName = activeNetwork()
): boolean {
  return venueNetworks(venue).includes(network)
}

/** Whether the venue with this id is on the network. An id nobody listed is not. */
export function venueIdOn(id: string, network: StellarNetworkName = activeNetwork()): boolean {
  const venue = venues.find((v) => v.id === id)
  return venue !== undefined && isVenueOn(venue, network)
}

export function venuesOn(network: StellarNetworkName = activeNetwork()): Venue[] {
  return venues.filter((v) => isVenueOn(v, network))
}

/**
 * "Not on mainnet yet", for a Stellar venue that is not, shown on mainnet;
 * nothing otherwise. An EVM venue lives on another chain entirely, and the
 * Stellar flag says nothing about it.
 */
export function notOnNetworkLabel(
  venue: Pick<Venue, 'family' | 'networks'>,
  network: StellarNetworkName = activeNetwork(),
  onNetwork: boolean = isVenueOn(venue, network)
): string | undefined {
  if (network !== 'mainnet' || venue.family !== 'stellar') return undefined
  return onNetwork ? undefined : 'Not on mainnet yet'
}

/** The test anchor exists only for testnet. On mainnet it is not coming, so it is not listed. */
export function isListedOn(
  venue: Pick<Venue, 'id'>,
  network: StellarNetworkName = activeNetwork()
): boolean {
  return !(venue.id === 'testanchor' && network === 'mainnet')
}

/**
 * What a venue's card says it does. A capability describes the network it works
 * on, so a venue not on this one gets only its summary.
 */
export function venueDetail(
  venue: Pick<Venue, 'bestFor' | 'capability'>,
  notHere: string | undefined
): string {
  return notHere === undefined ? (venue.capability ?? venue.bestFor) : venue.bestFor
}

/**
 * Which venues the Apps page may call available here — decided on the
 * server, because MoneyGram's mainnet presence depends on configuration the
 * browser cannot see. The static list, plus MoneyGram once its production
 * domain is named.
 */
export function availableVenueIds(
  network: StellarNetworkName = activeNetwork(),
  env: Record<string, string | undefined> = process.env
): Set<string> {
  const ids = new Set(venuesOn(network).map((v) => v.id))
  if (anchorsOn(network, env).includes('moneygram')) ids.add('moneygram')
  return ids
}

/**
 * Refuses, by name, a venue that is not on the network. Every builder calls
 * this first, so "unavailable on mainnet" is a property of the code rather
 * than of which menu a request happened to come through.
 */
export function assertVenueOn(id: string, network: StellarNetworkName = activeNetwork()): void {
  if (venueIdOn(id, network)) return
  const name = venues.find((v) => v.id === id)?.name ?? id
  throw new Error(`${name} is not on ${network} yet`)
}
