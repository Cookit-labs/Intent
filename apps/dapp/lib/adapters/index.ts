'use client'

import { nearDescriptor, solanaDescriptor, suiDescriptor } from '@intent/config'
import type { StellarNetworkName } from '@intent/config'
import type { ChainDescriptor, ChainSlug } from '@intent/types'

import type { ChainAdapter } from '../chain-adapter'
import { nearConnector, solanaConnector, suiConnector } from '../wallet/connectors'
import { arcAdapter, avalancheAdapter, monadAdapter } from './evm-adapter'
import { stellarAdapterFor } from './stellar-adapter'
import { storeAdapter } from './store-adapter'

type StoreChain = ChainDescriptor & { slug: 'solana' | 'sui' | 'near' }

const solanaAdapter = storeAdapter(solanaDescriptor as StoreChain, solanaConnector)
const suiAdapter = storeAdapter(suiDescriptor as StoreChain, suiConnector)
const nearAdapter = storeAdapter(nearDescriptor as StoreChain, nearConnector)

export function adapterFor(slug: ChainSlug, network: StellarNetworkName | undefined): ChainAdapter {
  switch (slug) {
    case 'stellar':
      return stellarAdapterFor(network as StellarNetworkName)
    case 'arc':
      return arcAdapter
    case 'avalanche':
      return avalancheAdapter
    case 'monad':
      return monadAdapter
    case 'solana':
      return solanaAdapter
    case 'sui':
      return suiAdapter
    case 'near':
      return nearAdapter
  }
}
