/**
 * One bounded line, for anything that crosses from outside into the prompt.
 *
 * Route paths carry asset codes anyone can issue. A venue's API echoes token
 * codes it chose. The user typed the intent. All of it lands in the same text
 * the brief is written in, and the model cannot tell a fact from an
 * instruction: a newline in an asset code reads as the next line of the
 * brief, and a long enough note is a paragraph. So the boundary makes every
 * value one line of printable characters with a visible cap. It does not try
 * to detect injection — that is the validator's job, downstream and
 * deterministic — it only removes the shapes that let text pretend to be
 * structure.
 */

const DEFAULT_MAX = 120

/** Control characters and line breaks, which are what a value uses to pretend to be structure. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g
const WHITESPACE = /[\s ]+/g

export function promptSafe(value: string, max: number = DEFAULT_MAX): string {
  const flat = value.replace(CONTROL, ' ').replace(WHITESPACE, ' ').trim()
  if (flat.length <= max) return flat
  // The marker is part of the budget, so a capped value is never longer than
  // an uncapped one and the cut is visible to whoever reads the prompt.
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}
