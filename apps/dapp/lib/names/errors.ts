/**
 * The three ways a recipient ends without an address to pay.
 *
 * Kept apart because they call for different responses. A name that does not
 * exist is the user's to fix; a lookup that could not be completed is the
 * network's, and retrying a typo is as pointless as correcting an outage. And
 * something this app cannot pay at all — a contract, a muxed account, a word
 * that is no kind of address — is neither, and should say so before any
 * network is asked.
 */

export class NameNotFound extends Error {
  override name = 'NameNotFound'
}

export class NameLookupFailed extends Error {
  override name = 'NameLookupFailed'
}

export class UnsupportedRecipient extends Error {
  override name = 'UnsupportedRecipient'
}
