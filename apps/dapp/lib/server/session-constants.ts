/**
 * Values shared between the Node session helpers and the edge middleware.
 *
 * Separate from `session.ts` because that module imports `node:crypto`, which
 * the edge runtime does not provide — importing it from middleware would fail
 * the build even if only a string constant were used.
 */
export const SESSION_COOKIE = 'intent_access'
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
