/**
 * Phrases people actually use for tokenized real-world assets.
 *
 * Kept apart from the ticker table because these are multi-word and the ticker
 * table matches single symbols. "Buy $100 of Mexican treasury bills" contains
 * no symbol at all, and nobody types "CETES" unprompted.
 *
 * Order matters. The country-specific patterns run first so an unqualified
 * "treasuries" only falls through to the US bond when no country was named —
 * matching the generic pattern first would read "Mexican treasuries" as US
 * debt, which is a different country's credit risk.
 */

const RWA_PHRASES: readonly (readonly [RegExp, string])[] = [
  [/\bmexican\s+(?:treasur\w*|bonds?|debt|bills?)\b/i, 'CETES'],
  [/\bcetes\b/i, 'CETES'],
  [/\bkorean\s+(?:treasur\w*|bonds?|debt|bills?)\b/i, 'KTB'],
  [/\bktb\b/i, 'KTB'],
  [/\b(?:us|u\.s\.|american)\s+(?:treasur\w*|t-?bills?|bonds?|debt)\b/i, 'USTRY'],
  [/\bustry\b/i, 'USTRY'],
  // Last, and only reached when no country was named.
  [/\btreasur\w*\b/i, 'USTRY'],
  [/\bt-?bills?\b/i, 'USTRY'],
] as const

/** The real-world asset a sentence refers to, if any. */
export function detectRealWorldAsset(text: string): string | undefined {
  for (const [pattern, code] of RWA_PHRASES) {
    if (pattern.test(text)) return code
  }
  return undefined
}
