/**
 * A repeat click on a link already loading restarts the request from the back of
 * the queue, so it arrives later the more it is clicked. Repeats are ignored,
 * until `windowMs` has passed, so a navigation that never ends cannot kill a link.
 */
export function createNavGuard(
  windowMs = 60_000,
  now: () => number = Date.now
): { follow: (href: string) => boolean; settle: () => void } {
  let pending: { href: string; at: number } | undefined
  return {
    follow: (href) => {
      if (pending?.href === href && now() - pending.at < windowMs) return false
      pending = { href, at: now() }
      return true
    },
    settle: () => {
      pending = undefined
    },
  }
}
