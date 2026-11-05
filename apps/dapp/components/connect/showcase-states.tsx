'use client'

import { CHAIN_DESCRIPTORS, CONNECT_CHAINS } from '@intent/config'
import { ChainMark, cn } from '@intent/ui'
import { motion, type MotionValue, type Transition } from 'framer-motion'
import { ArrowDown, ArrowUp, Check } from 'lucide-react'
import Image from 'next/image'
import { useCallback, useSyncExternalStore, type ComponentType } from 'react'

/** Milliseconds into the current state. Infinity shows the state finished, for reduced motion. */
export type Clock = MotionValue<number>

/**
 * Everything inside a state is a pure function of its clock, so a jump has no
 * timers to cancel and nothing to get out of step. Reads must return a primitive.
 */
export function useBeat<T extends string | number | boolean>(
  clock: Clock,
  read: (ms: number) => T
): T {
  const subscribe = useCallback((notify: () => void) => clock.on('change', notify), [clock])
  const snapshot = (): T => read(clock.get())
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

const PRESS_MS = 170
/** The press that sets off the next state lands just before the bar runs out. */
const FINAL_PRESS_BEFORE_END_MS = 300
/** Where a state's own story ends, and it can hold without the bar. */
export const SETTLED_BEFORE_END_MS = 420

const SNAP: Transition = { type: 'spring', stiffness: 460, damping: 34 }
const GLIDE: Transition = { type: 'spring', stiffness: 260, damping: 29 }

export const isPressed = (presses: number[], ms: number): boolean =>
  presses.some((at) => ms >= at && ms < at + PRESS_MS)

const progress = (ms: number, from: number, to: number): number =>
  Math.min(1, Math.max(0, (ms - from) / (to - from)))

const easeOut = (x: number): number => 1 - (1 - x) ** 3

function ExampleTag(): JSX.Element {
  return <span className="text-muted-foreground text-xs">Example</span>
}

function Tick({ on }: { on: boolean }): JSX.Element {
  return (
    <span className="bg-muted relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full">
      <motion.span
        className="bg-brand text-brand-foreground absolute inset-0 flex items-center justify-center rounded-full"
        initial={false}
        animate={{ scale: on ? 1 : 0, opacity: on ? 1 : 0 }}
        transition={SNAP}
      >
        <Check className="h-3 w-3" strokeWidth={3} />
      </motion.span>
    </span>
  )
}

const PILL = { width: 440, height: 76 }
const TYPED = 'Swap 100 USDC for SOL'
const TYPE_FROM_MS = 700
const MS_PER_LETTER = 62
const TYPED_BY_MS = TYPE_FROM_MS + TYPED.length * MS_PER_LETTER
const SAY_MS = 5000
const SAY_PRESSES = [450, SAY_MS - FINAL_PRESS_BEFORE_END_MS]
const SEND_X = PILL.width / 2 - 14 - 24

function SayContent({ clock }: { clock: Clock }): JSX.Element {
  const letters = useBeat(clock, (ms) =>
    Math.floor(progress(ms, TYPE_FROM_MS, TYPED_BY_MS) * TYPED.length)
  )
  const caret = useBeat(clock, (ms) => ms >= 450 && ms < 1e7 && Math.floor(ms / 480) % 2 === 0)
  const sending = useBeat(clock, (ms) => isPressed([SAY_PRESSES[1] as number], ms))
  const ready = letters === TYPED.length

  return (
    <div
      className="flex shrink-0 items-center gap-3 pl-8 pr-3.5"
      style={{ width: PILL.width, height: PILL.height }}
    >
      <p className="flex min-w-0 flex-1 items-center whitespace-nowrap text-lg font-medium tracking-tight">
        {letters > 0 ? (
          TYPED.slice(0, letters)
        ) : (
          <span className="text-muted-foreground font-normal">Describe the outcome you want…</span>
        )}
        <span
          className={cn(
            'bg-brand ml-0.5 h-6 w-0.5 rounded-full',
            caret ? 'opacity-100' : 'opacity-0'
          )}
        />
      </p>
      <motion.span
        className={cn(
          'flex h-12 w-12 shrink-0 items-center justify-center rounded-full transition-colors duration-200',
          ready ? 'bg-brand text-brand-foreground' : 'bg-muted text-muted-foreground'
        )}
        initial={false}
        animate={{ scale: sending ? 0.88 : 1 }}
        transition={SNAP}
      >
        <ArrowUp className="h-5 w-5" strokeWidth={2.25} />
      </motion.span>
    </div>
  )
}

/** What each agent offers at each round. The lead changes hands, which is the point. */
const AGENTS: { name: string; quotes: number[] }[] = [
  { name: 'Agent one', quotes: [0.604, 0.609, 0.612, 0.614] },
  { name: 'Agent two', quotes: [0.606, 0.607, 0.615, 0.618] },
  { name: 'Agent three', quotes: [0.601, 0.611, 0.613, 0.616] },
]
const ROUND_AT_MS = [0, 1000, 1950, 2900]
const QUOTE_ROLL_MS = 420
const DECIDED_MS = 3550
const QUOTE_FLOOR = 0.596
const QUOTE_CEILING = 0.62

const CARD = { width: 440, height: 300 }
const ROW_HEIGHT = 60
const ROW_GAP = 8
const COMPETE_MS = 6000

const roundAt = (ms: number): number => ROUND_AT_MS.filter((at) => ms >= at).length - 1

function rankIn(round: number, name: string): number {
  return [...AGENTS]
    .sort((a, b) => (b.quotes[round] ?? 0) - (a.quotes[round] ?? 0))
    .findIndex((agent) => agent.name === name)
}

function quoteAt(quotes: number[], ms: number): number {
  const round = roundAt(ms)
  const now = quotes[round] ?? 0
  if (round === 0) return now
  const before = quotes[round - 1] ?? now
  return (
    before +
    (now - before) *
      progress(ms, ROUND_AT_MS[round] ?? 0, (ROUND_AT_MS[round] ?? 0) + QUOTE_ROLL_MS)
  )
}

function AgentRow({
  clock,
  name,
  quotes,
}: {
  clock: Clock
  name: string
  quotes: number[]
}): JSX.Element {
  const round = useBeat(clock, roundAt)
  const decided = useBeat(clock, (ms) => ms >= DECIDED_MS)
  const quote = useBeat(clock, (ms) => quoteAt(quotes, ms).toFixed(3))
  const rank = rankIn(round, name)
  const won = decided && rank === 0
  const fill = won
    ? 100
    : (((quotes[round] ?? 0) - QUOTE_FLOOR) / (QUOTE_CEILING - QUOTE_FLOOR)) * 100

  return (
    <motion.li
      className="bg-muted absolute inset-x-0 top-0 overflow-hidden rounded-2xl"
      style={{ height: ROW_HEIGHT }}
      initial={false}
      animate={{ y: rank * (ROW_HEIGHT + ROW_GAP), opacity: decided && !won ? 0.55 : 1 }}
      transition={GLIDE}
    >
      <motion.span
        className="bg-bubble-me absolute inset-y-0 left-0"
        initial={false}
        animate={{ width: `${fill}%` }}
        transition={{ duration: 0.42, ease: 'easeOut' }}
      />
      <span
        className={cn(
          'relative flex h-full items-center gap-3 px-4 text-[15px] transition-colors duration-200',
          won && 'text-bubble-me-foreground font-medium'
        )}
      >
        <span className="flex-1">{name}</span>
        <span className="font-medium tabular-nums">{quote} SOL</span>
        <motion.span
          className="-ml-3 overflow-hidden"
          initial={false}
          animate={{ width: won ? 32 : 0 }}
          transition={GLIDE}
        >
          <span className="flex w-8 justify-end">
            <Tick on={won} />
          </span>
        </motion.span>
      </span>
    </motion.li>
  )
}

function CompeteContent({ clock }: { clock: Clock }): JSX.Element {
  return (
    <div className="flex shrink-0 flex-col justify-between p-5" style={CARD}>
      <div className="flex items-center justify-between">
        <p className="bg-bubble-me text-bubble-me-foreground rounded-2xl px-3.5 py-2 text-sm font-medium">
          {TYPED}
        </p>
        <ExampleTag />
      </div>
      <ul className="relative" style={{ height: ROW_HEIGHT * 3 + ROW_GAP * 2 }}>
        {AGENTS.map((agent) => (
          <AgentRow key={agent.name} clock={clock} name={agent.name} quotes={agent.quotes} />
        ))}
      </ul>
    </div>
  )
}

const HUB_DIAMETER = 156
const RING_RADIUS = 158
const COIN_SIZE = 62
const ARRIVE_FROM_MS = 380
const ARRIVE_STAGGER_MS = 120
const TOUR_FROM_MS = 1350
const TOUR_STEP_MS = 480
const TOUR_ENDS_MS = TOUR_FROM_MS + TOUR_STEP_MS * CONNECT_CHAINS.length
const CHAINS_MS = 6000
const CHAINS_FINAL_PRESS = CHAINS_MS - FINAL_PRESS_BEFORE_END_MS

/** Each chain lights in turn, finishing back on Stellar, the one the cursor then presses. */
function litChainAt(ms: number): number {
  if (ms === Infinity || ms < TOUR_FROM_MS) return -1
  if (ms >= TOUR_ENDS_MS) return 0
  return Math.floor((ms - TOUR_FROM_MS) / TOUR_STEP_MS)
}

function HubContent({ clock }: { clock: Clock }): JSX.Element {
  const lit = useBeat(clock, litChainAt)
  const chain = CONNECT_CHAINS[lit]
  return (
    <div
      className="relative flex shrink-0 items-center justify-center"
      style={{ width: HUB_DIAMETER, height: HUB_DIAMETER }}
    >
      <motion.span initial={false} animate={{ y: chain ? -9 : 0 }} transition={GLIDE}>
        <Image
          src="/images/intent-logo.png"
          alt=""
          width={512}
          height={361}
          className="h-10 w-auto"
        />
      </motion.span>
      <span className="text-muted-foreground absolute inset-x-0 bottom-9 text-center text-xs font-medium">
        {chain ? CHAIN_DESCRIPTORS[chain].name : null}
      </span>
    </div>
  )
}

const ringPoints = CONNECT_CHAINS.map((chain, i) => {
  const angle = (i / CONNECT_CHAINS.length) * Math.PI * 2 - Math.PI / 2
  return { chain, x: Math.cos(angle) * RING_RADIUS, y: Math.sin(angle) * RING_RADIUS }
})

/** Sits behind the shape, so the marks come out from under it and go back the same way. */
export function ChainRing({
  clock,
  on,
  instant,
}: {
  clock: Clock
  on: boolean
  instant: boolean
}): JSX.Element {
  return (
    <div className="pointer-events-none absolute left-1/2 top-1/2 z-0 h-0 w-0">
      {ringPoints.map((point, i) => (
        <ChainCoin key={point.chain} clock={clock} on={on} instant={instant} index={i} {...point} />
      ))}
    </div>
  )
}

function ChainCoin({
  clock,
  on,
  instant,
  index,
  chain,
  x,
  y,
}: {
  clock: Clock
  on: boolean
  instant: boolean
  index: number
  chain: (typeof CONNECT_CHAINS)[number]
  x: number
  y: number
}): JSX.Element {
  const arrived = useBeat(clock, (ms) => on && ms >= ARRIVE_FROM_MS + index * ARRIVE_STAGGER_MS)
  const lit = useBeat(clock, (ms) => on && litChainAt(ms) === index)
  const pressed = useBeat(clock, (ms) => on && index === 0 && isPressed([CHAINS_FINAL_PRESS], ms))
  const scale = pressed ? 0.92 : lit ? 1.08 : 1

  return (
    <motion.span
      className={cn(
        'text-foreground absolute flex items-center justify-center rounded-full transition-colors duration-200',
        lit ? 'bg-bubble-me' : 'bg-background'
      )}
      style={{
        width: COIN_SIZE,
        height: COIN_SIZE,
        left: -COIN_SIZE / 2,
        top: -COIN_SIZE / 2,
      }}
      initial={false}
      animate={arrived ? { x, y, scale, opacity: 1 } : { x: 0, y: 0, scale: 0.55, opacity: 0 }}
      transition={instant ? { duration: 0 } : GLIDE}
    >
      <ChainMark chain={chain} className="h-7 w-7" />
    </motion.span>
  )
}

const RECEIPT = { width: 304, height: 404 }
const NAIRA = 68_500
const COUNT_FROM_MS = 800
const COUNT_TO_MS = 2500
const STEPS = [
  { label: 'USDC sent', at: 800 },
  { label: 'Converted to naira', at: 2500 },
  { label: 'Paid to your bank', at: 3300 },
]
const NAIRA_MS = 6000

function ReceiptStep({
  clock,
  label,
  at,
}: {
  clock: Clock
  label: string
  at: number
}): JSX.Element {
  const done = useBeat(clock, (ms) => ms >= at)
  return (
    <li
      className={cn(
        'flex items-center gap-3 text-[15px] transition-opacity duration-200',
        done ? 'opacity-100' : 'opacity-40'
      )}
    >
      <Tick on={done} />
      {label}
    </li>
  )
}

function ReceiptContent({ clock }: { clock: Clock }): JSX.Element {
  const naira = useBeat(clock, (ms) =>
    Math.round(easeOut(progress(ms, COUNT_FROM_MS, COUNT_TO_MS)) * NAIRA)
  )
  return (
    <div className="flex shrink-0 flex-col p-6" style={RECEIPT}>
      <div className="flex items-baseline justify-between">
        <p className="text-muted-foreground text-sm">You send</p>
        <ExampleTag />
      </div>
      <p className="mt-1 text-[28px] font-semibold tabular-nums leading-tight tracking-tight">
        50 USDC
      </p>
      <div className="my-4 flex items-center gap-3">
        <span className="bg-muted text-muted-foreground flex h-7 w-7 items-center justify-center rounded-full">
          <ArrowDown className="h-4 w-4" />
        </span>
        <span className="bg-border h-px flex-1" />
      </div>
      <p className="text-muted-foreground text-sm">You get</p>
      <p className="text-brand mt-1 text-[44px] font-semibold tabular-nums leading-tight tracking-tight">
        <span className="mr-0.5">₦</span>
        {naira.toLocaleString('en-NG')}
      </p>
      <ul className="border-border mt-auto space-y-3.5 border-t border-dashed pt-5">
        {STEPS.map((step) => (
          <ReceiptStep key={step.label} clock={clock} label={step.label} at={step.at} />
        ))}
      </ul>
    </div>
  )
}

export interface Slide {
  key: string
  title: string
  body: string
  /** The active bar's length, and so how long this state stays. */
  ms: number
  shape: { width: number; height: number; radius: number }
  Content: ComponentType<{ clock: Clock }>
  /** Where the cursor heads, from each moment on. Relative to the shape's centre. */
  cursor: { at: number; x: number; y: number }[]
  presses: number[]
}

export const SLIDES: Slide[] = [
  {
    key: 'say',
    title: 'Say what you want',
    body: 'Type the outcome in plain words. Intent works out the steps, and you sign.',
    ms: SAY_MS,
    shape: { ...PILL, radius: PILL.height / 2 },
    Content: SayContent,
    cursor: [
      { at: 0, x: -150, y: 8 },
      { at: 800, x: -40, y: 66 },
      { at: 2300, x: SEND_X, y: 8 },
    ],
    presses: SAY_PRESSES,
  },
  {
    key: 'compete',
    title: 'Agents compete for your trade',
    body: 'Autonomous agents bid on your intent, and the best result wins.',
    ms: COMPETE_MS,
    shape: { ...CARD, radius: 30 },
    Content: CompeteContent,
    cursor: [
      { at: 0, x: 176, y: 176 },
      { at: 4000, x: 48, y: -34 },
    ],
    presses: [COMPETE_MS - FINAL_PRESS_BEFORE_END_MS],
  },
  {
    key: 'chains',
    title: 'Six chains, one place',
    body: 'Connect on Stellar, Solana, Avalanche, Sui, Monad or NEAR.',
    ms: CHAINS_MS,
    shape: { width: HUB_DIAMETER, height: HUB_DIAMETER, radius: HUB_DIAMETER / 2 },
    Content: HubContent,
    cursor: [
      { at: 0, x: 92, y: 104 },
      { at: 4000, x: 8, y: -150 },
    ],
    presses: [CHAINS_FINAL_PRESS],
  },
  {
    key: 'naira',
    title: 'Cash out to naira',
    body: 'Turn USDC into naira in your bank account. Available on Stellar today.',
    ms: NAIRA_MS,
    shape: { ...RECEIPT, radius: 30 },
    Content: ReceiptContent,
    cursor: [
      { at: 0, x: 178, y: 104 },
      { at: 3900, x: 44, y: 168 },
    ],
    presses: [NAIRA_MS - FINAL_PRESS_BEFORE_END_MS],
  },
]

export function ShowcaseCursor({ clock, slide }: { clock: Clock; slide: Slide }): JSX.Element {
  const leg = useBeat(clock, (ms) => slide.cursor.filter((point) => ms >= point.at).length - 1)
  const pressed = useBeat(clock, (ms) => isPressed(slide.presses, ms))
  const point = slide.cursor[leg] ?? slide.cursor[0]

  return (
    <motion.svg
      viewBox="0 0 20 22"
      className="pointer-events-none absolute left-1/2 top-1/2 z-20 h-[22px] w-5 overflow-visible"
      style={{ transformOrigin: '3px 2px' }}
      initial={false}
      animate={{ x: point?.x ?? 0, y: point?.y ?? 0, scale: pressed ? 0.82 : 1 }}
      transition={{
        x: { type: 'spring', stiffness: 62, damping: 15 },
        y: { type: 'spring', stiffness: 62, damping: 15 },
        scale: SNAP,
      }}
    >
      <path
        d="M3 2v15.5l4.4-3.9 2.9 6.4 2.6-1.2-2.9-6.2H16L3 2Z"
        className="fill-foreground stroke-background"
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
    </motion.svg>
  )
}
