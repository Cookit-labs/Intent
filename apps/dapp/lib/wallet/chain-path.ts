/** The same screen under another chain's segment. Everything deeper is chain-independent. */
export function pathUnderChain(pathname: string, segment: string): string {
  const rest = pathname.split('/').slice(2).join('/')
  return `/${segment}${rest === '' ? '/intents' : `/${rest}`}`
}

const DEFAULT_SCREEN = '/intents'

/**
 * The connect page's address for someone who asked for a screen on a chain and
 * has no wallet there. Just the bare address when they asked for the default one.
 */
export function connectAddress(pathname: string, search: string): string {
  const rest = pathname.split('/').slice(2).join('/')
  const screen = `/${rest}${search}`
  if (screen === '/' || screen === DEFAULT_SCREEN) return '/'
  return `/?next=${encodeURIComponent(screen)}`
}

/**
 * The screen to open once a chain is picked, from the connect page's `next`.
 *
 * It comes from the address, so anyone can write it. It is only ever put after a
 * chain segment, and is refused unless it is plainly a path on this site.
 */
export function screenAfterConnect(next: string | null): string {
  if (next === null || !next.startsWith('/') || next.startsWith('//')) return DEFAULT_SCREEN
  if (next.includes('\\') || next.includes('..')) return DEFAULT_SCREEN
  try {
    const url = new URL(next, 'https://intent.invalid')
    if (url.origin !== 'https://intent.invalid' || url.pathname === '/') return DEFAULT_SCREEN
    return `${url.pathname}${url.search}`
  } catch {
    return DEFAULT_SCREEN
  }
}
