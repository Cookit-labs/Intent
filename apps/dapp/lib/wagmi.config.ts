import { connectorsForWallets } from '@rainbow-me/rainbowkit'
import { injectedWallet, walletConnectWallet } from '@rainbow-me/rainbowkit/wallets'
import { arcTestnet as arcTestnetConfig } from '@intent/config'
import { createConfig, http } from 'wagmi'
import { defineChain } from 'viem'
import { avalanche, monad } from 'viem/chains'

/**
 * The viem chain, derived from the shared config rather than redeclared, so
 * chain values live in exactly one place. `packages/config/src/chain.ts` is
 * that place.
 */
export const arcTestnet = defineChain({
  id: arcTestnetConfig.id,
  name: arcTestnetConfig.name,
  nativeCurrency: arcTestnetConfig.nativeCurrency,
  rpcUrls: {
    default: { http: [arcTestnetConfig.rpcUrl] },
  },
  blockExplorers: {
    default: {
      name: 'ArcScan',
      url: arcTestnetConfig.blockExplorerUrl,
    },
  },
  testnet: true,
})

const projectId = process.env['NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID'] ?? ''
const hasProjectId = projectId !== '' && projectId !== 'your-project-id'

/**
 * Connectors are assembled by hand rather than via `getDefaultConfig`, because
 * that helper throws when `projectId` is missing — it will not degrade. A
 * WalletConnect id requires an external signup at cloud.reown.com, and without
 * this the app cannot even build for anyone who has not done it.
 *
 * Browser wallets are discovered by name through EIP-6963, so only the generic
 * injected wallet and WalletConnect are declared. WalletConnect is the way in
 * for mobile wallets, and shows its own QR code.
 */
const wallets = hasProjectId ? [injectedWallet, walletConnectWallet] : [injectedWallet]

if (!hasProjectId && typeof window !== 'undefined') {
  console.warn(
    '[wallet] NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is unset. ' +
      'Browser-extension wallets work; WalletConnect and mobile wallets are unavailable. ' +
      'Get an id at https://cloud.reown.com'
  )
}

const connectors = connectorsForWallets([{ groupName: 'Wallets', wallets }], {
  appName: 'Intent',
  projectId,
})

export const wagmiConfig = createConfig({
  connectors,
  chains: [arcTestnet, avalanche, monad],
  transports: {
    [arcTestnet.id]: http(arcTestnetConfig.rpcUrl),
    [avalanche.id]: http(),
    [monad.id]: http(),
  },
  ssr: true,
})
