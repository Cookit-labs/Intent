import type { ChainSlug } from '@intent/types'

import { avalancheCapabilities, monadCapabilities } from './evm/capabilities'
import type { ChainCapability } from './explain'
import { nearCapabilities } from './near/capabilities'
import { solanaCapabilities } from './solana/capabilities'
import { suiCapabilities } from './sui/capabilities'

/** The chain's capabilities, or nothing on a chain that doesn't use this path. */
export function chainCapabilities(slug: ChainSlug): readonly ChainCapability[] | undefined {
  if (slug === 'solana') return solanaCapabilities
  if (slug === 'sui') return suiCapabilities
  if (slug === 'near') return nearCapabilities
  if (slug === 'avalanche') return avalancheCapabilities
  if (slug === 'monad') return monadCapabilities
  return undefined
}
