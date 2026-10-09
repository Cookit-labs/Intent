/**
 * String equality that does not stop at the first difference. Edge-safe: the
 * Node session path uses `timingSafeEqual`, which the edge runtime lacks.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
