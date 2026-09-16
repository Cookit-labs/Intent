import type { IntentType } from '@intent/types'

/**
 * Which intents wait for a price.
 *
 * One definition, because there were two and they disagreed about
 * `accumulate`. The intent store counted it as a limit type while the
 * competition route did not, so "accumulate $200 of XLM below $0.19" was
 * quoted with no price floor and could fill straight through the limit it
 * named — the same class of bug as a limit order behaving like a market order,
 * arrived at from the other direction.
 *
 * `accumulate` belongs here: it names a price and declines above it. That it
 * also implies buying over time is a separate question from whether it has a
 * limit.
 *
 * Lives in its own module so a server route and the client store can both use
 * it without importing each other.
 */
export function isLimitType(type: IntentType | string): boolean {
  return type === 'limit_buy' || type === 'limit_sell' || type === 'accumulate'
}
