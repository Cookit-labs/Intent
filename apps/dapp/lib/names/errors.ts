/**
 * The two ways a name lookup ends without an address.
 *
 * Kept apart because they call for different responses. A name that does not
 * exist is the user's to fix; a lookup that could not be completed is the
 * network's, and retrying a typo is as pointless as correcting an outage.
 */

export class NameNotFound extends Error {
  override name = 'NameNotFound'
}

export class NameLookupFailed extends Error {
  override name = 'NameLookupFailed'
}
