/**
 * Where "Launch dApp" goes, derived from the dApp origin at build time.
 *
 * It goes to the dApp itself and nothing deeper. The dApp decides where to open
 * (Stellar mainnet when it serves it) and has its own menu for the other chains,
 * so the website no longer needs to know which chains or networks exist.
 *
 * Deliberately no fallback origin. A default like `http://localhost:3001` names a
 * port, not an app: any other project started first owns that port, and the
 * button would hand visitors someone else's site with no visible error. Unset
 * means "not configured", and the button renders disabled with a label written
 * for the visitor. The variable's name belongs in the console warning the
 * component prints for whoever deploys the site, never in text a visitor reads.
 */
export const UNAVAILABLE = 'Not available yet'

/** The dApp's origin without a trailing slash, or null when it is not configured. */
export function dappHref(dappUrl: string | undefined): string | null {
  const origin = (dappUrl ?? '').trim().replace(/\/+$/, '')
  return origin === '' ? null : origin
}
