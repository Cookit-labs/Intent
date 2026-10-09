/**
 * Whether the OTP access gate is on.
 *
 * `ACCESS_GATE=on|off` decides outright. Unset, the gate follows the
 * network: on for mainnet, where an open dApp fronting real funds needs a
 * door, and off for testnet, where it only gets in the way. Any other value
 * is treated as unset rather than as either answer, so a typo on mainnet
 * leaves the door shut.
 *
 * Decided at request time in the middleware, because `matcher` is static
 * and cannot carry a decision. Pure and free of Node imports: the
 * middleware runs on the edge.
 */

type Env = Record<string, string | undefined>

/**
 * `network` is the one the request is for. With several networks served the
 * gate follows it: mainnet is behind the door and testnet stays open. Without
 * it, the deployment's own network decides, as before.
 */
export function gateEnabled(env: Env, network?: 'testnet' | 'mainnet'): boolean {
  const flag = env['ACCESS_GATE']?.trim().toLowerCase()
  if (flag === 'on') return true
  if (flag === 'off') return false
  return (network ?? env['NEXT_PUBLIC_STELLAR_NETWORK']?.trim()) === 'mainnet'
}
