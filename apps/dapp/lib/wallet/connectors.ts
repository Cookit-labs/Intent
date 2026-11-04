'use client'

import type { ChainSlug } from '@intent/types'
import { avalanche, monad } from 'viem/chains'

import { stellarConnector } from '../adapters/stellar-adapter'
import { arcTestnet } from '../wagmi.config'
import { signSolana } from '../chains/solana/sign'
import { signSui } from '../chains/sui/sign'
import type { WalletConnector } from './connector'
import { createEvmConnector } from './evm-connector'
import { nearConnector } from './near-connector'
import { createStandardConnector } from './standard-connector'

export const solanaConnector = createStandardConnector({
  storageKey: 'intent.wallet.solana',
  chain: 'solana:mainnet',
  sign: signSolana,
  known: [
    { name: 'Phantom', installUrl: 'https://phantom.com/download' },
    { name: 'Solflare', installUrl: 'https://solflare.com' },
    { name: 'Backpack', installUrl: 'https://backpack.app' },
  ],
})

export const suiConnector = createStandardConnector({
  storageKey: 'intent.wallet.sui',
  chain: 'sui:mainnet',
  sign: signSui,
  known: [
    { name: 'Slush', installUrl: 'https://slush.app' },
    { name: 'Suiet', installUrl: 'https://suiet.app' },
  ],
})

export { nearConnector }

const CONNECTORS: Record<ChainSlug, WalletConnector> = {
  stellar: stellarConnector,
  solana: solanaConnector,
  sui: suiConnector,
  near: nearConnector,
  arc: createEvmConnector(arcTestnet.id),
  avalanche: createEvmConnector(avalanche.id),
  monad: createEvmConnector(monad.id),
}

export function connectorFor(slug: ChainSlug): WalletConnector {
  return CONNECTORS[slug]
}
