/**
 * Whether the OTP access gate is on.
 *
 * PAUSED. Anyone can open the app and connect a wallet; the email waitlist is
 * not asked for. Only `ACCESS_GATE=on` turns it back on, on any network.
 * To restore the old behaviour (on for mainnet, off for testnet), swap the body
 * of `gateEnabled` for the commented one below.
 *
 * Decided at request time in the middleware, because `matcher` is static
 * and cannot carry a decision. Pure and free of Node imports: the
 * middleware runs on the edge.
 */

type Env = Record<string, string | undefined>

/** `network` is kept so callers need no change when the gate is restored; it is unused while paused. */
export function gateEnabled(env: Env, _network?: 'testnet' | 'mainnet'): boolean {
  return env['ACCESS_GATE']?.trim().toLowerCase() === 'on'
}

// The gate as it was, to restore when the waitlist comes back:
//
// export function gateEnabled(env: Env, network?: 'testnet' | 'mainnet'): boolean {
//   const flag = env['ACCESS_GATE']?.trim().toLowerCase()
//   if (flag === 'on') return true
//   if (flag === 'off') return false
//   return (network ?? env['NEXT_PUBLIC_STELLAR_NETWORK']?.trim()) === 'mainnet'
// }
