/** Holds the chain last connected to, so the bare root can open on it. Read by middleware. */
export const CHAIN_COOKIE = 'intent-chain'

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

export function rememberChain(segment: string): void {
  document.cookie = `${CHAIN_COOKIE}=${segment}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`
}

export function forgetChain(): void {
  document.cookie = `${CHAIN_COOKIE}=; path=/; max-age=0; samesite=lax`
}
