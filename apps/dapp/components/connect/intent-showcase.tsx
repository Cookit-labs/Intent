'use client'

import { cn } from '@intent/ui'
import {
  AnimatePresence,
  motion,
  motionValue,
  useAnimationFrame,
  useReducedMotion,
  type Transition,
} from 'framer-motion'
import { Pause, Play } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

import {
  ChainRing,
  isPressed,
  SETTLED_BEFORE_END_MS,
  ShowcaseCursor,
  SLIDES,
  useBeat,
  type Slide,
} from './showcase-states'

/** The states are drawn in this space, then scaled to fit, so they fit every window alike. */
const STAGE = { width: 500, height: 470 }
const MIN_SCALE = 0.6
const MAX_SCALE = 1.6

const MORPH: Transition = { type: 'spring', stiffness: 190, damping: 23 }
const DIP: Transition = { type: 'spring', stiffness: 520, damping: 32 }
const INSTANT: Transition = { duration: 0 }

function useStageScale(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)

  useLayoutEffect(() => {
    const stage = ref.current
    if (!stage) return
    const measure = (): void => {
      const fit = Math.min(stage.clientWidth / STAGE.width, stage.clientHeight / STAGE.height)
      setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, fit)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  return [ref, scale]
}

/**
 * Short enough that the swap reads as the shape changing, not as a cut. The old
 * contents leave first, so two sets of words are never legible over each other.
 */
const swap = (reduced: boolean) =>
  reduced
    ? {
        initial: { opacity: 1 },
        animate: { opacity: 1, transition: INSTANT },
        exit: { opacity: 0, transition: INSTANT },
      }
    : {
        initial: { opacity: 0, filter: 'blur(8px)' },
        animate: {
          opacity: 1,
          filter: 'blur(0px)',
          transition: { duration: 0.2, delay: 0.06, ease: 'easeOut' as const },
          transitionEnd: { filter: 'none' },
        },
        exit: {
          opacity: 0,
          filter: 'blur(8px)',
          transition: { duration: 0.1, ease: 'easeIn' as const },
        },
      }

/**
 * What Intent does, told by one white shape that never cuts. Every state is the
 * same element changing size and corners, and only what it holds is swapped.
 *
 * The active bar's animation is the timer: its end is what moves on. The states
 * read their beats from it, and carry on to their finished picture if the bar is
 * held by a hover, so that choosing one with the mouse still plays it through.
 */
export function IntentShowcase(): JSX.Element {
  const reduced = useReducedMotion() ?? false
  const [active, setActive] = useState(0)
  const [hovered, setHovered] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [stageRef, scale] = useStageScale()

  // One clock each, so a state on its way out keeps the picture it had.
  const [clocks] = useState(() => SLIDES.map(() => motionValue(0)))
  const slide = SLIDES[active] as Slide
  const clock = clocks[active] as (typeof clocks)[number]
  const { Content, shape } = slide

  const barRef = useRef<HTMLSpanElement>(null)
  const storyMs = useRef(0)
  const chosen = useRef(false)

  useLayoutEffect(() => {
    storyMs.current = 0
    clock.set(reduced ? Infinity : 0)
  }, [clock, reduced])

  useAnimationFrame((_, delta) => {
    if (reduced) return
    if (!stopped || chosen.current) {
      storyMs.current = Math.min(storyMs.current + delta, slide.ms - SETTLED_BEFORE_END_MS)
    }
    const bar = barRef.current?.getAnimations()[0]
    const barMs = typeof bar?.currentTime === 'number' ? bar.currentTime : 0
    const now = Math.max(storyMs.current, barMs)
    if (stopped && bar) bar.currentTime = now
    clock.set(now)
  })

  const pressed = useBeat(clock, (ms) => isPressed(slide.presses, ms))

  const choose = (next: number): void => {
    if (next === active) return
    chosen.current = true
    setActive(next)
  }

  const togglePlay = (): void => {
    chosen.current = false
    setStopped((value) => !value)
  }

  const swapMotion = swap(reduced)

  return (
    <aside
      aria-label="What Intent does"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="showcase-panel bg-brand text-brand-foreground relative isolate m-3 ml-0 flex min-w-0 flex-1 flex-col overflow-hidden rounded-3xl"
    >
      <div className="flex items-center gap-2 px-6 pt-4">
        <div className="flex flex-1 gap-1.5">
          {SLIDES.map((s, i) => (
            <button
              key={s.key}
              type="button"
              onClick={() => choose(i)}
              aria-label={`Show slide ${i + 1}: ${s.title}`}
              aria-current={i === active ? 'true' : undefined}
              className="focus-visible:ring-brand-foreground group flex-1 rounded py-2 focus-visible:outline-none focus-visible:ring-2"
            >
              <span
                className={cn(
                  'group-hover:bg-brand-foreground/40 block h-1 overflow-hidden rounded-full transition-colors',
                  i === active ? 'bg-brand-foreground/40' : 'bg-brand-foreground/25'
                )}
              >
                {i < active || (i === active && reduced) ? (
                  <span className="bg-brand-foreground block h-full w-full" />
                ) : null}
                {i === active && !reduced ? (
                  <span
                    ref={barRef}
                    onAnimationEnd={() => {
                      chosen.current = false
                      setActive((a) => (a + 1) % SLIDES.length)
                    }}
                    className="bg-brand-foreground block h-full w-full origin-left"
                    style={{
                      animation: `showcase-progress ${s.ms}ms linear forwards`,
                      animationPlayState: hovered || stopped ? 'paused' : 'running',
                    }}
                  />
                ) : null}
              </span>
            </button>
          ))}
        </div>
        {!reduced ? (
          <button
            type="button"
            onClick={togglePlay}
            aria-label={stopped ? 'Play slides' : 'Pause slides'}
            className="hover:bg-brand-foreground/15 focus-visible:ring-brand-foreground flex h-7 w-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2"
          >
            {stopped ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </button>
        ) : null}
      </div>

      <div
        ref={stageRef}
        className="relative flex min-h-0 flex-1 items-center justify-center"
        aria-hidden
      >
        <div
          className="relative flex shrink-0 items-center justify-center"
          style={{ ...STAGE, transform: `scale(${scale})` }}
        >
          <ChainRing clock={clock} on={slide.key === 'chains'} instant={reduced} />
          <motion.div
            className="bg-background text-foreground relative z-10 shrink-0 overflow-hidden"
            style={{ boxShadow: '0 20px 48px hsl(237 45% 18% / 0.32)' }}
            initial={false}
            animate={{
              width: shape.width,
              height: shape.height,
              borderRadius: shape.radius,
              scale: pressed ? 0.972 : 1,
            }}
            transition={reduced ? INSTANT : { ...MORPH, scale: DIP }}
          >
            <AnimatePresence initial={false}>
              <motion.div
                key={slide.key}
                className="absolute inset-0 flex items-center justify-center"
                {...swapMotion}
              >
                <Content clock={clock} />
              </motion.div>
            </AnimatePresence>
          </motion.div>
          {!reduced ? <ShowcaseCursor clock={clock} slide={slide} /> : null}
        </div>
      </div>

      <div className="relative grid min-h-[9.5rem] px-10 pb-10 pt-1 text-center">
        <AnimatePresence initial={false}>
          <motion.div key={slide.key} className="[grid-area:1/1]" {...swapMotion}>
            <h2 className="font-display text-balance text-3xl font-semibold tracking-tight xl:text-4xl">
              {slide.title}
            </h2>
            <p className="text-brand-foreground/80 mx-auto mt-3 max-w-md text-balance leading-relaxed">
              {slide.body}
            </p>
          </motion.div>
        </AnimatePresence>
      </div>
    </aside>
  )
}
