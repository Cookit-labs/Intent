const STELLAR = /^G[A-Z2-7]{55}$/
const EVM = /^0x[0-9a-fA-F]{40}$/
const SUI = /^0x[0-9a-fA-F]{64}$/
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const NEAR_IMPLICIT = /^[0-9a-f]{64}$/
/** Named NEAR accounts always have a dot once they are under a top-level account like `.near`. */
const NEAR_NAMED = /^(?:[a-z0-9]+(?:[-_][a-z0-9]+)*\.)+[a-z0-9]+(?:[-_][a-z0-9]+)*$/

/**
 * Whether a value has the shape of an address on a chain the app connects to.
 * Only a record key where it is used, so shape is enough and no checksum is read.
 */
export function isWalletAddress(value: string): boolean {
  return [STELLAR, EVM, SUI, SOLANA, NEAR_IMPLICIT, NEAR_NAMED].some((shape) => shape.test(value))
}
