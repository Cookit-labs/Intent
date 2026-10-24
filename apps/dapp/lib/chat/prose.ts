/**
 * What a model wrote, made fit for a chat bubble.
 *
 * Models lean on em dashes however they are asked, and the product does not
 * use them, so they are rewritten here rather than trusted to the prompt: a
 * spaced dash between clauses becomes a sentence break, a tight one a comma.
 * An en dash inside a range such as 3–5% is left alone. Line breaks are kept,
 * since the bubble shows them, with runs of blank lines folded to one and
 * markdown list markers turned into bullets.
 */
export function tidyProse(text: string): string {
  return text
    .replace(/[ \t]+[—–][ \t]+(\S)/g, (_, next: string) => `. ${next.toUpperCase()}`)
    .replace(/[ \t]*—[ \t]*/g, ', ')
    .replace(/\.\s*\.\s/g, '. ')
    .replace(/^[ \t]*[-*][ \t]+/gm, '• ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
