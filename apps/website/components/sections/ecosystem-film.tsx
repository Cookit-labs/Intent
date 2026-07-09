'use client'

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  ArrowUp,
  BadgeCheck,
  Bot,
  FileUp,
  ImagePlus,
  Lock,
  MousePointer2,
  Plus,
  Radio,
  UserPlus,
} from 'lucide-react'

const BRAND = '#6366f1'
const VERIFIED_BLUE = '#1D9BF0'

type Phase =
  | 'boot'
  | 'type'
  | 'send'
  | 'lock'
  | 'addmenu'
  | 'compete'
  | 'recommend'
  | 'choose'
  | 'launch'
  | 'settle'
  | 'done'
type ComposerPointer = 'hidden' | 'send-move' | 'send-click' | 'plus-move' | 'plus-click'

const USER_INTENT = 'Accumulate 2.0 ETH below $3,200 — max 0.50% slippage, fill within 30s.'

interface Agent {
  key: string
  name: string
  role: string
  img: string
  strategy: string
  proposal: string
  recommended?: boolean
}

const AGENTS: Agent[] = [
  {
    key: 'twap',
    name: 'TWAP',
    role: 'Time-weighted',
    img: '/images/Image1.webp',
    strategy:
      'Slicing the buy into 6 tranches across the window so my footprint stays invisible to the book.',
    proposal: '$3,201.40 avg · 0.18% slip',
  },
  {
    key: 'momentum',
    name: 'Momentum',
    role: 'Breakout timing',
    img: '/images/image2.webp',
    strategy:
      'Holding for the retest of the $3,180 level, then filling the whole clip in one clean shot.',
    proposal: '$3,203.10 avg · 0.24% slip',
  },
  {
    key: 'arb',
    name: 'Arbitrage',
    role: 'Cross-venue',
    img: '/images/image3.webp',
    strategy:
      'Routing across Curve and Uniswap to capture a 4bp spread the single-venue agents are leaving on the table.',
    proposal: '$3,198.90 avg · 0.11% slip',
  },
  {
    key: 'shadow',
    name: 'Shadow',
    role: 'Path search',
    img: '/images/image4.jpg',
    strategy:
      'Simulated 40 execution paths — the best is a hidden-order split across two pools. Tightest fill, lowest slip.',
    proposal: '$3,197.60 avg · 0.09% slip',
    recommended: true,
  },
]

const SHADOW = AGENTS.find((a) => a.recommended)!
const SETTLE_STEPS = [
  'Execution submitted',
  'Validated on Arc L1',
  'USDC settled',
  'Reputation updated',
]

// Token lands exactly on each node. Five stops from Intent (0) to Arc (1):
// Escrow → Compete → Execute → Settle → Arc.
const PROGRESS: Record<Phase, number> = {
  boot: 0,
  type: 0,
  send: 0,
  lock: 0.2,
  addmenu: 0.2,
  compete: 0.4,
  recommend: 0.4,
  choose: 0.4,
  launch: 0.6,
  settle: 0.8,
  done: 1,
}

const RAIL_NODES = [
  { label: '', at: 0, live: (p: number) => p >= 0 },
  { label: 'Escrow', at: 0.2, live: (p: number) => p >= 0.2 },
  { label: 'Compete', at: 0.4, live: (p: number) => p >= 0.4 },
  { label: 'Execute', at: 0.6, live: (p: number) => p >= 0.6 },
  { label: 'Settle', at: 0.8, live: (p: number) => p >= 0.8 },
  { label: '', at: 1, live: (p: number) => p >= 1 },
]

type Msg =
  | { id: number; kind: 'user' }
  | { id: number; kind: 'system'; text: string; icon: 'lock' | 'robot' | 'radio' }
  | { id: number; kind: 'agent'; agentKey: string }
  | { id: number; kind: 'settle' }

export function EcosystemFilm() {
  const reduced = useReducedMotion()
  const [cycle, setCycle] = useState(0)
  const [phase, setPhase] = useState<Phase>('boot')
  const [inputText, setInputText] = useState('')
  const [inputSent, setInputSent] = useState(false)
  const [composerPointer, setComposerPointer] = useState<ComposerPointer>('hidden')
  const [menuOpen, setMenuOpen] = useState(false)
  const [chosen, setChosen] = useState(false)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [typing, setTyping] = useState<string[]>([])
  const [doneStep, setDoneStep] = useState(-1)
  const [settledValue, setSettledValue] = useState(0)
  const [secondsLeft, setSecondsLeft] = useState(30)

  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (reduced) {
      setPhase('done')
      setInputSent(true)
      setChosen(true)
      setMsgs([
        { id: 0, kind: 'user' },
        { id: 1, kind: 'system', text: '10,000 USDC locked in escrow', icon: 'lock' },
        ...AGENTS.map((a, i) => ({ id: 10 + i, kind: 'agent' as const, agentKey: a.key })),
        {
          id: 20,
          kind: 'system',
          text: 'System recommends Shadow — you chose it to execute',
          icon: 'robot',
        },
        { id: 21, kind: 'settle' },
      ])
      setDoneStep(3)
      setSettledValue(10000)
      setSecondsLeft(0)
      return
    }

    let cancelled = false
    const timeouts: ReturnType<typeof setTimeout>[] = []
    let uid = 0
    const nextId = () => uid++
    const at = (ms: number, fn: () => void) => {
      const t = setTimeout(() => {
        if (!cancelled) fn()
      }, ms)
      timeouts.push(t)
    }
    type MsgInput = Msg extends infer T ? (T extends Msg ? Omit<T, 'id'> : never) : never
    const push = (m: MsgInput) => setMsgs((prev) => [...prev, { ...m, id: nextId() } as Msg])

    setPhase('boot')
    setInputText('')
    setInputSent(false)
    setComposerPointer('hidden')
    setMenuOpen(false)
    setChosen(false)
    setMsgs([])
    setTyping([])
    setDoneStep(-1)
    setSettledValue(0)
    setSecondsLeft(30)

    // Act I — user types the intent and sends it
    at(500, () => {
      setPhase('type')
      let i = 0
      const step = () => {
        i++
        setInputText(USER_INTENT.slice(0, i))
        if (i < USER_INTENT.length) at(26, step)
      }
      step()
    })
    at(2700, () => {
      setPhase('send')
      setComposerPointer('send-move')
    })
    at(3200, () => {
      setComposerPointer('send-click')
      push({ kind: 'user' })
      setInputText('')
      setInputSent(true)
    })
    at(3600, () => setComposerPointer('hidden'))
    at(3900, () => {
      setPhase('lock')
      push({ kind: 'system', text: '10,000 USDC locked in escrow', icon: 'lock' })
    })

    // Act II — user adds agents via the + menu, agents strategize
    at(4500, () => {
      setPhase('addmenu')
      setComposerPointer('plus-move')
    })
    at(5000, () => {
      setComposerPointer('plus-click')
      setMenuOpen(true)
    })
    at(6000, () => {
      setMenuOpen(false)
      setComposerPointer('hidden')
      setPhase('compete')
      setTyping(AGENTS.map((a) => a.key))
    })
    const postOrder = ['twap', 'momentum', 'arb', 'shadow']
    const postTimes = [6900, 8100, 9400, 10800]
    postOrder.forEach((key, idx) => {
      at(postTimes[idx]!, () => {
        setTyping((t) => t.filter((k) => k !== key))
        push({ kind: 'agent', agentKey: key })
      })
    })

    // Act III — system recommends, user chooses, execute, settle
    at(11700, () => {
      setPhase('recommend')
      push({
        kind: 'system',
        text: 'System recommends Shadow — strongest strategy. You pick who executes.',
        icon: 'robot',
      })
    })
    at(12900, () => {
      setPhase('choose')
      setChosen(true)
    })
    at(13900, () => {
      setPhase('launch')
      push({ kind: 'system', text: "Executing Shadow's route on Arc L1", icon: 'radio' })
    })
    at(14800, () => {
      setPhase('settle')
      push({ kind: 'settle' })
    })
    at(15100, () => setDoneStep(0))
    at(15900, () => setDoneStep(1))
    at(16700, () => {
      setDoneStep(2)
      const steps = 16
      for (let s = 1; s <= steps; s++)
        at(s * 22, () => setSettledValue(Math.round((10000 / steps) * s)))
    })
    at(17500, () => setDoneStep(3))
    at(18200, () => setPhase('done'))

    at(22000, () => setCycle((c) => c + 1))

    return () => {
      cancelled = true
      timeouts.forEach(clearTimeout)
    }
  }, [cycle, reduced])

  // Competition countdown
  useEffect(() => {
    if (reduced || (phase !== 'compete' && phase !== 'recommend' && phase !== 'choose')) return
    const start = performance.now()
    let raf: number
    const tick = (now: number) => {
      const remaining = Math.max(0, 30 - ((now - start) / 6900) * 30)
      setSecondsLeft(Math.ceil(remaining))
      if (remaining > 0) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [phase, reduced])

  // Keep the transcript pinned to the newest message — scroll the container
  // itself, never scrollIntoView (which would drag the whole page).
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduced ? 'auto' : 'smooth' })
  }, [msgs, typing, inputText, doneStep, reduced])

  const progress = PROGRESS[phase]
  const competing = phase === 'compete' || phase === 'recommend' || phase === 'choose'
  const recommending = ['recommend', 'choose', 'launch', 'settle', 'done'].includes(phase)
  const armed = inputText.length > 0
  const pointerBase = composerPointer.startsWith('send')
    ? 'send'
    : composerPointer.startsWith('plus')
      ? 'plus'
      : null
  const pointerClick = composerPointer.endsWith('click')

  return (
    <div className="w-full">
      {/* Window */}
      <div
        className="relative w-full overflow-hidden rounded-[28px] border border-white/50 md:rounded-[36px]"
        style={{
          background: 'rgba(255,255,255,0.28)',
          backdropFilter: 'blur(20px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.4)',
          boxShadow: '0 1px 0 0 rgba(255,255,255,0.6) inset, 0 28px 70px -28px rgba(17,17,26,0.2)',
        }}
      >
        <div className="relative z-10 flex flex-col p-5 md:p-8">
          {/* Window chrome */}
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
              <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
              <span className="h-3 w-3 rounded-full bg-[#28c840]" />
            </div>
            <span className="text-muted-foreground/60 font-sans text-xs">Live settlement</span>
            <div className="flex items-center gap-1.5">
              <motion.span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: competing ? VERIFIED_BLUE : BRAND }}
                animate={{ opacity: [1, 0.3, 1] }}
                transition={{ duration: 1.4, repeat: Infinity }}
              />
              <span className="text-muted-foreground/60 min-w-[42px] font-sans text-xs tabular-nums">
                {competing ? `00:${String(secondsLeft).padStart(2, '0')}` : 'Live'}
              </span>
            </div>
          </div>

          {/* Chat transcript */}
          <div
            ref={scrollRef}
            className="mt-6 h-[440px] overflow-y-auto pr-1 [scrollbar-width:none] md:h-[540px] [&::-webkit-scrollbar]:hidden"
          >
            <div className="flex flex-col gap-3.5">
              {msgs.map((m) => (
                <MessageRow
                  key={m.id}
                  msg={m}
                  recommending={recommending}
                  chosen={chosen}
                  doneStep={doneStep}
                  settledValue={settledValue}
                />
              ))}

              <AnimatePresence>
                {typing.length > 0 && (
                  <motion.div
                    key="typing-cluster"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, height: 0 }}
                    className="flex flex-col gap-2"
                  >
                    <span className="text-muted-foreground/60 ml-11 font-sans text-[11px]">
                      {typing.length} agents strategizing…
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {AGENTS.filter((a) => typing.includes(a.key)).map((a) => (
                        <motion.div
                          key={a.key}
                          layout
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.9 }}
                          className="border-border bg-card/80 flex items-center gap-2 rounded-full border py-1.5 pl-1.5 pr-3"
                        >
                          <Avatar agent={a} size={22} />
                          <TypingDots />
                        </motion.div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Composer input */}
          <div className="border-border bg-card relative mt-5 flex items-center gap-2 rounded-full border px-2.5 py-2.5">
            {/* + attach / add-agents */}
            <div className="relative shrink-0">
              <motion.button
                type="button"
                className="border-border text-muted-foreground grid h-9 w-9 place-items-center rounded-full border"
                animate={{
                  backgroundColor: menuOpen ? 'hsl(var(--foreground))' : 'hsl(var(--card))',
                  color: menuOpen ? 'hsl(var(--background))' : 'hsl(var(--muted-foreground))',
                  rotate: menuOpen ? 45 : 0,
                }}
                transition={{ duration: 0.2 }}
              >
                <Plus className="h-4 w-4" strokeWidth={2.5} />
              </motion.button>

              <AnimatePresence>
                {menuOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: 8, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 8, scale: 0.96 }}
                    transition={{ duration: 0.2 }}
                    className="border-border bg-card absolute bottom-full left-0 z-40 mb-3 w-52 overflow-hidden rounded-2xl border p-1.5 shadow-[0_20px_50px_-20px_rgba(17,17,26,0.35)]"
                  >
                    <MenuItem
                      icon={<FileUp className="h-4 w-4" strokeWidth={2} />}
                      label="Upload document"
                    />
                    <MenuItem
                      icon={<ImagePlus className="h-4 w-4" strokeWidth={2} />}
                      label="Upload image"
                    />
                    <MenuItem
                      icon={<UserPlus className="h-4 w-4" strokeWidth={2} />}
                      label="Add agents"
                      active
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="flex min-w-0 flex-1 items-center font-sans text-sm">
              {inputText ? (
                <span className="text-foreground truncate">{inputText}</span>
              ) : (
                <span className="text-muted-foreground/50">Message the agent network…</span>
              )}
              {phase === 'type' && (
                <span className="bg-foreground/50 ml-0.5 inline-block h-4 w-[2px] shrink-0 animate-pulse align-middle" />
              )}
            </div>

            <motion.div
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full"
              animate={{
                backgroundColor: armed || phase === 'send' ? 'hsl(var(--foreground))' : '#e6e6e0',
              }}
              transition={{ duration: 0.2 }}
            >
              <motion.div
                animate={{ scale: composerPointer === 'send-click' ? [1, 0.8, 1] : 1 }}
                transition={{ duration: 0.25 }}
              >
                <ArrowUp
                  className="h-4 w-4"
                  strokeWidth={2.5}
                  style={{
                    color:
                      armed || phase === 'send'
                        ? 'hsl(var(--background))'
                        : 'hsl(var(--muted-foreground))',
                  }}
                />
              </motion.div>
            </motion.div>

            <AnimatePresence>
              {pointerBase && (
                <motion.div
                  key={pointerBase}
                  className="pointer-events-none absolute z-50"
                  initial={{
                    opacity: 0,
                    left: pointerBase === 'send' ? '55%' : '20%',
                    top: '-150%',
                  }}
                  animate={{
                    opacity: 1,
                    left: pointerBase === 'send' ? 'calc(100% - 30px)' : '30px',
                    top: '52%',
                  }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.5, ease: 'easeInOut' }}
                >
                  <MousePointer2
                    className="text-foreground h-4 w-4 -rotate-12 drop-shadow"
                    fill="currentColor"
                  />
                  {pointerClick && (
                    <motion.span
                      className="absolute -inset-2 rounded-full border-2"
                      style={{ borderColor: BRAND }}
                      initial={{ scale: 0.3, opacity: 0.8 }}
                      animate={{ scale: 1.8, opacity: 0 }}
                      transition={{ duration: 0.5, ease: 'easeOut' }}
                    />
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Connective rail — value travelling Intent → Arc, outside the window */}
      <div className="mt-16 px-1 md:mt-20">
        <div className="flex items-center gap-2 sm:gap-4 md:gap-8">
          <motion.span
            className="bg-card shrink-0 rounded-full border px-3 py-1.5 font-sans text-xs font-medium sm:px-5 sm:py-2.5 sm:text-sm md:text-base"
            animate={{
              borderColor:
                phase !== 'boot' ? 'hsl(var(--foreground) / 0.28)' : 'hsl(var(--border))',
              color:
                phase !== 'boot' ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground) / 0.7)',
            }}
            transition={{ duration: 0.4 }}
          >
            Intent
          </motion.span>

          <div className="relative mx-1 h-[3px] flex-1">
            <div className="bg-border absolute inset-0 top-1/2 -translate-y-1/2" />
            <motion.div
              className="absolute left-0 top-1/2 h-[3px] origin-left -translate-y-1/2"
              style={{ background: BRAND }}
              animate={{ scaleX: progress }}
              transition={{ duration: 0.7, ease: [0.25, 0.46, 0.45, 0.94] }}
            />

            {RAIL_NODES.map((node) => {
              const live = node.live(progress)
              return (
                <div
                  key={node.at}
                  className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
                  style={{ left: `${node.at * 100}%` }}
                >
                  <motion.span
                    className="block h-3.5 w-3.5 rotate-45 rounded-[4px] border-2 sm:h-5 sm:w-5 md:h-6 md:w-6 md:rounded-[5px]"
                    animate={{
                      backgroundColor: live ? BRAND : 'hsl(var(--background))',
                      borderColor: live ? BRAND : 'hsl(var(--border))',
                    }}
                    transition={{ duration: 0.4 }}
                  />
                  {node.label && (
                    <span
                      className="absolute left-1/2 top-9 hidden -translate-x-1/2 whitespace-nowrap font-sans text-sm sm:block"
                      style={{ color: live ? BRAND : 'hsl(var(--muted-foreground) / 0.6)' }}
                    >
                      {node.label}
                    </span>
                  )}
                </div>
              )
            })}

            <motion.span
              className="absolute top-1/2 z-10 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[4px] sm:h-5 sm:w-5 md:h-6 md:w-6 md:rounded-[5px]"
              style={{ background: BRAND, boxShadow: '0 0 0 5px rgba(99,102,241,0.18)' }}
              animate={{ left: `${progress * 100}%` }}
              transition={{ duration: 0.7, ease: [0.25, 0.46, 0.45, 0.94] }}
            />
          </div>

          <motion.div
            className="relative h-14 w-14 shrink-0 sm:h-20 sm:w-20 md:h-32 md:w-32"
            animate={{ opacity: progress >= 1 ? 1 : 0.7, scale: progress >= 1 ? 1.05 : 1 }}
            transition={{ duration: 0.4 }}
          >
            <Image
              src="/images/Arc.png"
              alt="Arc L1"
              fill
              sizes="128px"
              className="object-contain"
            />
          </motion.div>
        </div>

        <div className="mt-14 flex h-5 items-center justify-center">
          <AnimatePresence mode="wait">
            <motion.span
              key={phase}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.3 }}
              className="text-muted-foreground/70 font-sans text-sm md:text-base"
            >
              {captionFor(phase)}
            </motion.span>
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

function captionFor(phase: Phase): string {
  switch (phase) {
    case 'type':
    case 'send':
      return 'Stating the intent'
    case 'lock':
      return 'Escrow locked'
    case 'addmenu':
      return 'Adding agents to the room'
    case 'compete':
      return 'Agents competing for the fill'
    case 'recommend':
      return 'System recommends the best strategy'
    case 'choose':
      return 'You choose who executes'
    case 'launch':
      return 'Executing on-chain'
    case 'settle':
      return 'Settling on Arc L1'
    case 'done':
      return 'Settled with finality'
    default:
      return 'Every winning execution lands on Arc'
  }
}

function MenuItem({
  icon,
  label,
  active,
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
}) {
  return (
    <div
      className={`flex items-center gap-2.5 rounded-xl px-3 py-2 font-sans text-sm ${
        active ? 'bg-brand/10 text-brand' : 'text-muted-foreground'
      }`}
    >
      {icon}
      {label}
    </div>
  )
}

function Avatar({ agent, size = 40 }: { agent: Agent; size?: number }) {
  return (
    <span
      className="relative shrink-0 overflow-hidden rounded-full border border-black/5"
      style={{ width: size, height: size }}
    >
      <Image src={agent.img} alt={agent.name} fill sizes={`${size}px`} className="object-cover" />
    </span>
  )
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="bg-muted-foreground/50 h-1.5 w-1.5 rounded-full"
          animate={{ opacity: [0.3, 1, 0.3], y: [0, -2, 0] }}
          transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15 }}
        />
      ))}
    </div>
  )
}

function MessageRow({
  msg,
  recommending,
  chosen,
  doneStep,
  settledValue,
}: {
  msg: Msg
  recommending: boolean
  chosen: boolean
  doneStep: number
  settledValue: number
}) {
  const base = {
    initial: { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.4 },
  }

  if (msg.kind === 'user') {
    return (
      <motion.div {...base} className="flex justify-end">
        <div className="bg-foreground max-w-[82%] rounded-2xl rounded-tr-sm px-4 py-3 md:max-w-[70%]">
          <p className="text-background m-0 font-sans text-sm leading-relaxed">{USER_INTENT}</p>
        </div>
      </motion.div>
    )
  }

  if (msg.kind === 'system') {
    const Icon = msg.icon === 'lock' ? Lock : msg.icon === 'radio' ? Radio : Bot
    const isRobot = msg.icon === 'robot'
    return (
      <motion.div {...base} className="flex justify-center">
        <span
          className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 font-sans text-[11px] ${
            isRobot
              ? 'border-foreground/15 bg-foreground/[0.04] text-foreground'
              : 'border-border bg-card/70 text-muted-foreground'
          }`}
        >
          {isRobot ? (
            <span className="bg-foreground grid h-5 w-5 place-items-center rounded-full">
              <Bot className="h-3 w-3" stroke="hsl(var(--background))" strokeWidth={2} />
            </span>
          ) : (
            <Icon className="text-brand h-3 w-3" strokeWidth={2} />
          )}
          {msg.text}
        </span>
      </motion.div>
    )
  }

  if (msg.kind === 'settle') {
    return (
      <motion.div {...base} className="flex gap-3">
        <Avatar agent={SHADOW} />
        <div className="border-border bg-card flex-1 rounded-2xl rounded-tl-sm border px-4 py-4">
          <SettleRow doneStep={doneStep} settledValue={settledValue} />
        </div>
      </motion.div>
    )
  }

  const agent = AGENTS.find((a) => a.key === msg.agentKey)!
  const isRecommended = Boolean(agent.recommended)
  const dimmed = chosen && !isRecommended

  return (
    <motion.div
      {...base}
      animate={{ opacity: dimmed ? 0.4 : 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="flex gap-3"
    >
      <Avatar agent={agent} />
      <div
        className="bg-card flex-1 rounded-2xl rounded-tl-sm border px-4 py-3"
        style={
          recommending && isRecommended
            ? { borderColor: BRAND, boxShadow: '0 0 0 1px rgba(99,102,241,0.35)' }
            : { borderColor: 'hsl(var(--border))' }
        }
      >
        <div className="flex items-center gap-2">
          <span className="text-foreground font-sans text-[13px] font-semibold">{agent.name}</span>
          <span className="text-muted-foreground/60 font-sans text-[11px]">{agent.role}</span>
          {recommending && isRecommended && (
            <motion.span
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 14 }}
              className="bg-foreground text-background ml-auto flex items-center gap-1 rounded-full px-2 py-0.5 font-sans text-[10px] font-medium"
            >
              <Bot className="h-3 w-3" strokeWidth={2} />
              Recommended
            </motion.span>
          )}
        </div>
        <p className="text-muted-foreground m-0 mt-1.5 font-sans text-[13px] leading-relaxed">
          {agent.strategy}
        </p>

        <div className="mt-2.5 flex items-center justify-between gap-3">
          <span className="text-foreground inline-block rounded-md bg-black/[0.04] px-2 py-1 font-sans text-[11px] tabular-nums">
            {agent.proposal}
          </span>

          <AnimatePresence>
            {recommending && (
              <motion.div
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                className="relative"
              >
                <motion.button
                  type="button"
                  className={`rounded-full px-3.5 py-1.5 font-sans text-[11px] font-medium ${
                    isRecommended ? 'text-background' : 'border-border text-muted-foreground border'
                  }`}
                  animate={{
                    backgroundColor: isRecommended ? 'hsl(var(--foreground))' : 'hsl(var(--card))',
                    scale: chosen && isRecommended ? [1, 0.92, 1] : 1,
                  }}
                  transition={{ duration: 0.3 }}
                >
                  Execute
                </motion.button>

                {isRecommended && (
                  <AnimatePresence>
                    {chosen && (
                      <motion.div
                        key="tap"
                        className="pointer-events-none absolute -bottom-3 -right-2 z-20"
                        initial={{ opacity: 0, x: 18, y: 18 }}
                        animate={{ opacity: 1, x: 0, y: 0 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.35, ease: 'easeOut' }}
                      >
                        <MousePointer2
                          className="text-foreground h-4 w-4 -rotate-12 drop-shadow"
                          fill="currentColor"
                        />
                        <motion.span
                          className="absolute -inset-2 rounded-full border-2"
                          style={{ borderColor: BRAND }}
                          initial={{ scale: 0.4, opacity: 0.8 }}
                          animate={{ scale: 1.8, opacity: 0 }}
                          transition={{ delay: 0.3, duration: 0.5, ease: 'easeOut' }}
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  )
}

function SettleRow({ doneStep, settledValue }: { doneStep: number; settledValue: number }) {
  const segmentLeft = [12.5, 37.5, 62.5]
  return (
    <div className="relative z-10 flex items-start justify-between">
      {segmentLeft.map((left, i) => (
        <div
          key={left}
          className="bg-border absolute top-3.5 h-[2px]"
          style={{ left: `${left}%`, width: '25%' }}
        >
          <motion.div
            className="h-full origin-left"
            style={{ background: VERIFIED_BLUE }}
            animate={{ scaleX: doneStep > i ? 1 : 0 }}
            transition={{ duration: 0.6, ease: 'easeInOut' }}
          />
        </div>
      ))}

      {SETTLE_STEPS.map((label, i) => {
        const done = doneStep >= i
        const justDone = doneStep === i
        return (
          <div key={label} className="relative z-10 flex flex-1 flex-col items-center text-center">
            <div className="relative flex h-7 w-7 items-center justify-center">
              <AnimatePresence>
                {justDone && (
                  <motion.span
                    initial={{ scale: 0.6, opacity: 0.9 }}
                    animate={{ scale: 2, opacity: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.7, ease: 'easeOut' }}
                    className="absolute inset-0 rounded-full border-2"
                    style={{ borderColor: VERIFIED_BLUE }}
                  />
                )}
              </AnimatePresence>
              <AnimatePresence mode="wait">
                {done ? (
                  <motion.div
                    key="done"
                    initial={{ scale: 0.5, opacity: 0, rotate: -20 }}
                    animate={{ scale: 1, opacity: 1, rotate: 0 }}
                    transition={{ type: 'spring', stiffness: 300, damping: 14 }}
                  >
                    <BadgeCheck
                      className="h-7 w-7"
                      fill={VERIFIED_BLUE}
                      stroke="white"
                      strokeWidth={1.75}
                    />
                  </motion.div>
                ) : (
                  <motion.div
                    key="pending"
                    animate={{ scale: [1, 1.06, 1] }}
                    transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
                    className="border-border bg-card h-7 w-7 rounded-full border-2"
                  />
                )}
              </AnimatePresence>
            </div>

            <div className="text-muted-foreground/70 mt-2 max-w-[10ch] font-sans text-[10px] leading-tight">
              {label}
            </div>

            <AnimatePresence>
              {i === 1 && done && (
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-muted-foreground mt-1 font-sans text-[10px] tabular-nums"
                >
                  0x8f21…d91c
                </motion.div>
              )}
              {i === 2 && done && (
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-foreground mt-1 font-sans text-[10px] tabular-nums"
                >
                  ${settledValue.toLocaleString()}
                </motion.div>
              )}
              {i === 3 && done && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.7 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 14 }}
                  className="text-success mt-1 font-sans text-[11px] font-semibold"
                >
                  +12
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )
      })}
    </div>
  )
}
