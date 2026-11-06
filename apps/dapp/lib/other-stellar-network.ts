import type { StellarNetworkName } from '@intent/config'

export interface OtherStellarNetwork {
  /** What the menu calls it: the network this deployment is not on. */
  label: string
  /** Where it lives. Absent when no second deployment is configured. */
  href?: string
}

/**
 * The Stellar network a deployment does not serve, and where to find it.
 *
 * A deployment is fixed to one network, because the venue lists, the
 * sponsor and the session gate are all decided for that network.
 * So the other network is a separate deployment, reached by a link. The
 * address comes from configuration and is used only if it is http or https,
 * so a bad value cannot become a `javascript:` link in the menu. A mainnet
 * deployment never links to testnet: people there should not see it exists.
 */
export function otherStellarNetwork(
  active: StellarNetworkName,
  otherUrl: string | undefined,
  path: string
): OtherStellarNetwork {
  const label = active === 'mainnet' ? 'Stellar testnet' : 'Stellar mainnet'
  const base = otherUrl?.trim().replace(/\/+$/, '')
  if (active === 'mainnet' || base === undefined || !/^https?:\/\/[^/]/i.test(base)) {
    return { label }
  }
  return { label, href: `${base}${path}` }
}
