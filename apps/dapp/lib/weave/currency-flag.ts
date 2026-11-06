const FLAGS: Readonly<Record<string, { src: string; country: string }>> = {
  NGN: { src: '/flags/ng.svg', country: 'Nigeria' },
  KES: { src: '/flags/ke.svg', country: 'Kenya' },
  UGX: { src: '/flags/ug.svg', country: 'Uganda' },
  TZS: { src: '/flags/tz.svg', country: 'Tanzania' },
}

/** The country's flag for a payout currency, from the local files in public/flags. */
export function currencyFlag(code: string): { src: string; country: string } | undefined {
  return FLAGS[code]
}

/** What to call the places a currency pays out to, from the kinds of institution it lists. */
export function payoutWord(
  types: readonly string[]
): 'bank' | 'mobile money provider' | 'bank or mobile money' {
  if (types.length > 0 && types.every((t) => t === 'mobile_money')) return 'mobile money provider'
  if (types.length > 0 && types.every((t) => t === 'bank')) return 'bank'
  return 'bank or mobile money'
}
