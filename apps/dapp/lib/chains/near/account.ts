/** A NEAR account id, as the protocol defines one. Implicit and named accounts both match. */
export const NEAR_ACCOUNT =
  /^(?=.{2,64}$)(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/

/** Base58 of 32 bytes, checked before a hash from the browser goes into a URL or an API call. */
export const NEAR_TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/
