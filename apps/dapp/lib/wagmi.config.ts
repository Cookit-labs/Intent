import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { mainnet, sepolia } from 'wagmi/chains'

// TODO: add Arc L1 chain definition
// const arcTestnet = defineChain({ id: 0, name: 'Arc Testnet', ... })

export const wagmiConfig = getDefaultConfig({
  appName: 'Intent',
  projectId: process.env['NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID'] ?? 'YOUR_PROJECT_ID',
  chains: [mainnet, sepolia], // TODO: add arcTestnet
  ssr: true,
})