import { avalancheModule, monadModule } from './evm/module'
import { nearModule } from './near/module'
import { solanaModule } from './solana/module'
import { suiModule } from './sui/module'
import type { ChainModule, ChainWithActions } from './types'

const MODULES: Record<ChainWithActions, ChainModule> = {
  solana: solanaModule,
  sui: suiModule,
  near: nearModule,
  avalanche: avalancheModule,
  monad: monadModule,
}

export function chainModule(chain: string): ChainModule | undefined {
  return Object.prototype.hasOwnProperty.call(MODULES, chain)
    ? MODULES[chain as ChainWithActions]
    : undefined
}
