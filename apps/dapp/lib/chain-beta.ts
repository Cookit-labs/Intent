import type { ChainSlug } from '@intent/types'

/** Raising this shows the notice again on every beta chain, once, for the next round of changes. */
export const BETA_RELEASE = 'v1'

/** Every chain but Stellar, which has been running longest. */
export function isBetaChain(slug: ChainSlug): boolean {
  return slug !== 'stellar'
}

/** What a screen reader gets for a chain, since a label on the control replaces the visible tag. */
export function chainLabelWithBeta(slug: ChainSlug, label: string): string {
  return isBetaChain(slug) ? `${label}, beta` : label
}

export function betaNoticeTitle(chainName: string): string {
  return `${chainName} is in beta`
}

export function betaNoticeIntro(chainName: string): string {
  return `Intent on ${chainName} is new and still being tested with real transactions.`
}

export const BETA_NOTICE_POINTS = [
  'A transaction can fail, and you may still pay the network fee.',
  'An app can be slow, refuse a request or be unavailable for a while.',
  'Apps here run on their own contracts, and a sent transaction can’t be reversed.',
] as const

export const BETA_NOTICE_ADVICE = 'Start with a small amount, and read each card before you sign.'

type NoticeStorage = Pick<Storage, 'getItem' | 'setItem'>

function noticeKey(slug: ChainSlug): string {
  return `intent-beta-notice:${BETA_RELEASE}:${slug}`
}

/**
 * Whether to show the notice on entering this chain. Storage a browser refuses counts as seen: the
 * tag still says beta, and the notice shouldn't come back on every page for that person.
 */
export function shouldShowBetaNotice(slug: ChainSlug, storage: NoticeStorage): boolean {
  if (!isBetaChain(slug)) return false
  try {
    return storage.getItem(noticeKey(slug)) === null
  } catch {
    return false
  }
}

export function rememberBetaNotice(slug: ChainSlug, storage: NoticeStorage): void {
  try {
    storage.setItem(noticeKey(slug), '1')
  } catch {
    // Nothing to do: the notice closes anyway, and `shouldShowBetaNotice` reads the same failure.
  }
}
