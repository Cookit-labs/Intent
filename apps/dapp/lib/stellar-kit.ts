import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit'
import { FreighterModule } from '@creit.tech/stellar-wallets-kit/modules/freighter'
import { AlbedoModule } from '@creit.tech/stellar-wallets-kit/modules/albedo'
import { LobstrModule } from '@creit.tech/stellar-wallets-kit/modules/lobstr'
import { RabetModule } from '@creit.tech/stellar-wallets-kit/modules/rabet'
import { HanaModule } from '@creit.tech/stellar-wallets-kit/modules/hana'
import { xBullModule } from '@creit.tech/stellar-wallets-kit/modules/xbull'
import { Networks } from '@creit.tech/stellar-wallets-kit/types'

/**
 * The Stellar wallet kit, initialised once.
 *
 * This replaces the direct `@stellar/freighter-api` calls the adapter used to
 * make. Freighter is one Stellar wallet among many, and hardcoding it excluded
 * everyone on xBull, Lobstr, Rabet, Albedo or Hana — the kit is the Stellar
 * equivalent of what RainbowKit does for EVM, including the picker modal.
 *
 * Modules are listed explicitly rather than pulled from the kit's "all modules"
 * export: each one is a separate bundle, and the hardware-wallet and
 * WalletConnect modules are large enough that shipping them unused is wasteful.
 */
let initialised = false

export function ensureKit(): void {
  if (initialised || typeof window === 'undefined') return

  StellarWalletsKit.init({
    modules: [
      new FreighterModule(),
      new xBullModule(),
      new LobstrModule(),
      new RabetModule(),
      new AlbedoModule(),
      new HanaModule(),
    ],
    network: Networks.TESTNET,
    authModal: { showInstallLabel: true },
  })

  initialised = true
}

export { StellarWalletsKit }
