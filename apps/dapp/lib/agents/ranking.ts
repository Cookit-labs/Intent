import type { ChatTurn } from '../chat-history'

/**
 * Ranking with uncertainty, so the board can say "not enough data yet".
 *
 * Seven models race, and a handful of races cannot order seven agents. A
 * win count shows an order anyway, and the order is mostly noise. Chatbot
 * Arena hit the same problem and moved from Elo to a Bradley–Terry fit with
 * bootstrap confidence intervals (https://www.lmsys.org/blog/2023-12-07-leaderboard/):
 * Bradley–Terry does not depend on the order races were played, and the
 * bootstrap gives each rating an interval whose width is the honest measure
 * of how little is known. That is the method here, at the scale of one
 * user's history rather than a million votes.
 */

/**
 * One paired outcome read from a race. `weight` is 1 for a decisive result
 * and 0.5 for each direction of a draw.
 */
export interface Comparison {
  winner: string
  loser: string
  weight: number
}

/**
 * Every race, read as the winner against each competitor that answered.
 *
 * A failed proposal is not a comparison: a timeout says nothing about the
 * agent's judgement, so it is neither a win for the winner nor a loss for the
 * agent that did not answer.
 *
 * A competitor whose score equals the winner's is a draw. `winner` is set on
 * every recorded turn, including a unanimous one where the pick among equals
 * was a coin flip; the turn does not carry the `unanimous` flag, so equality
 * of measured score is the record of a draw. A draw is split as half a win
 * each way rather than skipped: it still says the two are close, which a
 * skipped race would not.
 */
export function pairwiseOutcomes(turns: ChatTurn[]): Comparison[] {
  const out: Comparison[] = []

  for (const turn of turns) {
    if (turn.winner === null) continue
    const winner = turn.proposals[turn.winner]
    if (winner === undefined || winner.failed !== undefined) continue

    for (const other of Object.values(turn.proposals)) {
      if (other.key === winner.key || other.failed !== undefined) continue
      if (other.score === winner.score) {
        out.push({ winner: winner.key, loser: other.key, weight: 0.5 })
        out.push({ winner: other.key, loser: winner.key, weight: 0.5 })
      } else {
        out.push({ winner: winner.key, loser: other.key, weight: 1 })
      }
    }
  }

  return out
}

/**
 * Half a virtual comparison between every pair, split evenly.
 *
 * The Bradley–Terry likelihood has no finite maximum for an agent that has
 * never lost; its strength runs to infinity. A small uniform pseudo-count is
 * the usual remedy and keeps every fit finite. Half a comparison per pair is
 * light enough that five real races already dominate it.
 */
const PRIOR_COMPARISONS_PER_PAIR = 0.5
const MAX_ITERATIONS = 500
const TOLERANCE = 1e-9

function bump(map: Map<string, number>, key: string, by: number): void {
  map.set(key, (map.get(key) ?? 0) + by)
}

/**
 * Bradley–Terry strengths by maximum likelihood, as log-strength centred at 0.
 *
 * Under the model, P(i beats j) = p_i / (p_i + p_j). The fit is Zermelo's
 * iteration as written by Hunter (2004, "MM algorithms for generalized
 * Bradley-Terry models", Annals of Statistics 32(1)): each round sets
 * p_i = W_i / sum_j n_ij / (p_i + p_j), where W_i is i's wins and n_ij the
 * number of comparisons between i and j. The likelihood is invariant to
 * scaling every strength, so each round renormalises to a geometric mean of
 * 1, which puts the returned log-strengths at mean 0.
 *
 * Comparisons that name an agent outside `agents` are ignored.
 */
export function bradleyTerry(comparisons: Comparison[], agents: string[]): Record<string, number> {
  const keys = [...new Set(agents)]
  if (keys.length === 0) return {}
  const known = new Set(keys)

  const wins = new Map<string, number>()
  const counts = new Map<string, Map<string, number>>()
  const addCount = (a: string, b: string, weight: number): void => {
    const row = counts.get(a) ?? new Map<string, number>()
    bump(row, b, weight)
    counts.set(a, row)
  }
  const countOf = (a: string, b: string): number => counts.get(a)?.get(b) ?? 0

  for (const c of comparisons) {
    if (!known.has(c.winner) || !known.has(c.loser) || c.winner === c.loser) continue
    bump(wins, c.winner, c.weight)
    addCount(c.winner, c.loser, c.weight)
    addCount(c.loser, c.winner, c.weight)
  }
  for (const a of keys) {
    for (const b of keys) {
      if (a === b) continue
      bump(wins, a, PRIOR_COMPARISONS_PER_PAIR / 2)
      addCount(a, b, PRIOR_COMPARISONS_PER_PAIR)
    }
  }

  let strength = new Map<string, number>(keys.map((k) => [k, 1]))
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const next = new Map<string, number>()
    for (const a of keys) {
      const own = strength.get(a) ?? 1
      let denominator = 0
      for (const b of keys) {
        if (a === b) continue
        const n = countOf(a, b)
        if (n === 0) continue
        denominator += n / (own + (strength.get(b) ?? 1))
      }
      next.set(a, denominator === 0 ? 1 : (wins.get(a) ?? 0) / denominator)
    }

    let logMean = 0
    for (const v of next.values()) logMean += Math.log(v)
    logMean /= keys.length

    let delta = 0
    for (const [a, v] of next) {
      const normalised = Math.exp(Math.log(v) - logMean)
      next.set(a, normalised)
      delta = Math.max(delta, Math.abs(normalised - (strength.get(a) ?? 1)))
    }
    strength = next
    if (delta < TOLERANCE) break
  }

  return Object.fromEntries(keys.map((k) => [k, Math.log(strength.get(k) ?? 1)]))
}

/** Every agent that answered in at least one race, in first-seen order. */
function competitors(turns: ChatTurn[]): string[] {
  const keys = new Set<string>()
  for (const turn of turns) {
    for (const view of Object.values(turn.proposals)) {
      if (view.failed === undefined) keys.add(view.key)
    }
  }
  return [...keys]
}

/**
 * mulberry32: a 32-bit seeded generator, uniform on [0, 1).
 *
 * `Math.random` cannot be seeded, and an interval that changed on every
 * render would read as the data moving when nothing happened. Any decent
 * small PRNG would do; this one is a few lines and passes the usual
 * statistical batteries for its size.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Linear-interpolated quantile of an ascending list; undefined when empty. */
function percentile(sorted: number[], q: number): number | undefined {
  const position = (sorted.length - 1) * q
  const lower = sorted[Math.floor(position)]
  const upper = sorted[Math.ceil(position)]
  if (lower === undefined || upper === undefined) return undefined
  return lower + (upper - lower) * (position - Math.floor(position))
}

export interface Interval {
  low: number
  high: number
}

/**
 * 200 resamples is what Arena uses for its intervals, and Efron and
 * Tibshirani (An Introduction to the Bootstrap, 1993) give it as enough for
 * a percentile interval. It also keeps a seven-agent fit under a few
 * milliseconds on the client.
 */
export const BOOTSTRAP_SAMPLES = 200

/**
 * A 95% interval for each agent's log-strength, by resampling races.
 *
 * The race is the unit of resampling, not the comparison: the six
 * comparisons a seven-agent race yields all rest on the same winner, and
 * treating them as independent would make the interval far too narrow.
 * Each resample draws races with replacement, refits Bradley–Terry over the
 * agents present in it, and the 2.5th and 97.5th percentiles of an agent's
 * refitted strengths are its interval. An agent absent from a resample gives
 * that resample no vote, as in Arena's own notebook.
 *
 * Deterministic for a given seed, so a re-render shows the same numbers.
 */
export function bootstrapIntervals(
  turns: ChatTurn[],
  options: { samples?: number; seed?: number } = {}
): Record<string, Interval> {
  const samples = options.samples ?? BOOTSTRAP_SAMPLES
  const random = seededRandom(options.seed ?? 1)
  const agents = competitors(turns)
  if (agents.length === 0 || turns.length === 0) return {}

  const point = bradleyTerry(pairwiseOutcomes(turns), agents)
  const draws = new Map<string, number[]>(agents.map((key) => [key, []]))

  for (let s = 0; s < samples; s++) {
    const resample: ChatTurn[] = []
    for (let i = 0; i < turns.length; i++) {
      const pick = turns[Math.floor(random() * turns.length)]
      if (pick !== undefined) resample.push(pick)
    }
    const present = competitors(resample)
    const fit = bradleyTerry(pairwiseOutcomes(resample), present)
    for (const key of present) {
      const value = fit[key]
      if (value !== undefined) draws.get(key)?.push(value)
    }
  }

  return Object.fromEntries(
    agents.map((key) => {
      const sorted = (draws.get(key) ?? []).sort((a, b) => a - b)
      const low = percentile(sorted, 0.025)
      const high = percentile(sorted, 0.975)
      const fallback = point[key] ?? 0
      if (low === undefined || high === undefined) return [key, { low: fallback, high: fallback }]
      return [key, { low, high }]
    })
  )
}

/**
 * Below this many races the board does not rank at all.
 *
 * Five is the floor at which a percentile bootstrap has anything to
 * resample: with n races there are C(2n-1, n) distinct resamples, which is
 * 126 at n = 5 and 35 at n = 4. It is a floor, not a promise of accuracy;
 * the interval carries that.
 */
export const minimumRacesForRanking = 5

/**
 * Below this many races an agent's label is capped at 'medium'.
 *
 * Efron and Tibshirani (1993) are blunt that percentile intervals from very
 * small samples under-cover: a bootstrap can only reshuffle what it has
 * seen, and five identical races resample to five identical races and a
 * zero-width interval. Twenty is where the distinct resamples number in the
 * billions and the interval starts to mean what it says.
 */
export const racesForHighConfidence = 20

export type Confidence = 'none' | 'low' | 'medium' | 'high'

export interface RankedAgent {
  key: string
  name: string
  /** Arena-scaled rating: 1000 at the centre, 400 points per tenfold strength. */
  rating: number
  /** 95% bootstrap interval, on the same scale. */
  low: number
  high: number
  /** Races this agent answered in. */
  races: number
  /** Races it was picked in and outscored at least one competitor. */
  wins: number
  confidence: Confidence
}

/**
 * Arena's scale, so a number on this board means what it would mean there:
 * rating = 1000 + 400 * log10(strength). A 400-point gap is a 10:1 win ratio;
 * 100 points is roughly 64:36.
 */
const ARENA_CENTRE = 1000
const ARENA_POINTS_PER_DECADE = 400
function toArenaScale(logStrength: number): number {
  return ARENA_CENTRE + (ARENA_POINTS_PER_DECADE / Math.LN10) * logStrength
}

/**
 * A plain-words label for how much the interval lets one say.
 *
 * `width` is the agent's 95% interval and `spread` the distance between the
 * top and bottom ratings on the board, both in rating points. An interval
 * wider than the whole board ('low') cannot place the agent anywhere on it;
 * one narrower than half the board ('high') places it within a part. In
 * between is 'medium'. Race count caps the label: under five, 'none'; under
 * twenty, at most 'medium', for the reason given at `racesForHighConfidence`.
 */
function confidenceFor(races: number, width: number, spread: number): Confidence {
  if (races < minimumRacesForRanking) return 'none'
  if (spread <= 0 || width > spread) return 'low'
  if (width > spread / 2 || races < racesForHighConfidence) return 'medium'
  return 'high'
}

/** A race that can order anyone: it had a winner and at least two answers. */
function isRankableRace(turn: ChatTurn): boolean {
  if (turn.winner === null) return false
  const answered = Object.values(turn.proposals).filter((p) => p.failed === undefined)
  return answered.length >= 2 && answered.some((p) => p.key === turn.winner)
}

export function countRankableRaces(turns: ChatTurn[]): number {
  return turns.filter(isRankableRace).length
}

/** Whether the board should show a ranking rather than an insufficient-data notice. */
export function rankingIsMeaningful(turns: ChatTurn[]): boolean {
  return countRankableRaces(turns) >= minimumRacesForRanking && competitors(turns).length >= 2
}

/**
 * Every agent that raced, rated with its interval, best first.
 *
 * `wins` counts only decisive picks. A unanimous race records a `winner`
 * too, chosen among equals by a draw the agents cannot influence, and
 * counting that as a win is exactly the noise this ranking exists to stop
 * showing. `rankAgents` in `leaderboard.ts` still counts it, for callers that
 * want the raw record.
 */
export function rankWithConfidence(turns: ChatTurn[]): RankedAgent[] {
  const agents = competitors(turns)
  if (agents.length === 0) return []

  const strength = bradleyTerry(pairwiseOutcomes(turns), agents)
  const intervals = bootstrapIntervals(turns)

  const names = new Map<string, string>()
  const races = new Map<string, number>()
  const wins = new Map<string, number>()
  for (const turn of turns) {
    const winner = turn.winner === null ? undefined : turn.proposals[turn.winner]
    let decisive = false
    for (const view of Object.values(turn.proposals)) {
      if (view.failed !== undefined) continue
      // The latest name wins; a curated display name may have changed.
      names.set(view.key, view.name)
      bump(races, view.key, 1)
      if (winner !== undefined && view.key !== winner.key && view.score < winner.score) {
        decisive = true
      }
    }
    if (winner !== undefined && winner.failed === undefined && decisive) {
      bump(wins, winner.key, 1)
    }
  }

  const ratings = new Map(agents.map((key) => [key, toArenaScale(strength[key] ?? 0)]))
  const spread = Math.max(...ratings.values()) - Math.min(...ratings.values())

  return agents
    .map((key) => {
      const centre = strength[key] ?? 0
      const interval = intervals[key] ?? { low: centre, high: centre }
      const low = toArenaScale(interval.low)
      const high = toArenaScale(interval.high)
      const raced = races.get(key) ?? 0
      return {
        key,
        name: names.get(key) ?? key,
        rating: ratings.get(key) ?? ARENA_CENTRE,
        low,
        high,
        races: raced,
        wins: wins.get(key) ?? 0,
        confidence: confidenceFor(raced, high - low, spread),
      }
    })
    .sort(
      (a, b) =>
        b.rating - a.rating || b.wins - a.wins || b.races - a.races || a.name.localeCompare(b.name)
    )
}

/**
 * The position to print beside each row: one more than the number of
 * agents clearly ahead of it.
 *
 * "Clearly ahead" is Arena's rule: the other agent's whole interval sits
 * above this one's. Two agents whose intervals overlap cannot be told apart
 * by this data, and printing 2 and 3 beside them would claim otherwise; they
 * share a position instead. Rows are expected in rating order, as
 * `rankWithConfidence` returns them.
 */
export function rankPositions(rows: Pick<RankedAgent, 'low' | 'high'>[]): number[] {
  return rows.map((row) => 1 + rows.filter((other) => other.low > row.high).length)
}
