import type { Venue } from '@intent/types'

export const venues: Venue[] = [
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
    capability:
      'Swaps route through Soroswap’s Soroban router. On the same assets it has quoted several times the classic DEX price.',
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
    capability:
      'Swaps route through Aquarius’s router against the pool the agent chose. Which router wins depends on the direction of the trade.',
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
    capability:
      'Swaps and resting limit orders settle on the network’s own order book, read and written directly.',
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
    capability:
      'Buy tokenized Mexican, US and Korean treasury bills. They settle like any other classic asset.',
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
    capability:
      'Deposit both sides of a pair and earn a share of the 0.3% trading fee. Run by the network itself, with no contract to trust.',
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
    capability:
      'Rates are read live and XLM can be supplied. Borrowing is out of scope, so a position here can never be liquidated.',
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
    name: 'Noether',
    family: 'stellar' as const,
    category: 'perps',
    chains: ['Stellar'],
    bestFor: 'Leveraged longs and shorts, up to 10x',
    // The site answers; its `api.` and `docs.` subdomains do not resolve.
    url: 'https://noether.exchange',
    integration: 'quotes',
    capability:
      'Mark prices and open interest are read live, and “long XLM 10x with 50 USDC” prepares a position to sign. Signing needs an API key from its closed beta, so it is unverified end to end. Unaudited, testnet-only; its gateway reports 0.0.0-dev.',
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
    capability:
      'Type deon.xlm as a recipient and the payment goes to the address the name resolves to, shown in full before you sign. Names are read from the registry on Stellar mainnet; the payment settles here on testnet.',
  },
]
