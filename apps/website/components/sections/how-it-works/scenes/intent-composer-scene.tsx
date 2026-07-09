'use client'

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Lock, MousePointer2, Radio } from 'lucide-react'
import { GlassPanel } from '../glass-panel'
import { AmbientBlob } from '../ambient-blob'

interface IntentDraft {
  outcome: string
  params: { label: string; value: string }[]
  escrow: number
}

const INTENTS: IntentDraft[] = [
  {
    outcome: 'Accumulate 2.0 ETH below $3,200',
    params: [
      { label: 'Max slippage', value: '0.50%' },
      { label: 'Window', value: '30s' },
    ],
    escrow: 10000,
  },
  {
    outcome: 'Hedge 15,000 USDC exposure',
    params: [
      { label: 'Max slippage', value: '0.35%' },
      { label: 'Window', value: '30s' },
    ],
    escrow: 15000,
  },
  {
    outcome: 'Rebalance to 60 / 40 ETH · USDC',
    params: [
      { label: 'Max slippage', value: '0.40%' },
      { label: 'Window', value: '30s' },
    ],
    escrow: 8400,
  },
]

type Beat = 'typing' | 'params' | 'submitted' | 'escrow' | 'broadcast'
type CursorPhase = 'hidden' | 'move' | 'click'

export function IntentComposerScene() {
  const [intentIndex, setIntentIndex] = useState(0)
  const [typed, setTyped] = useState('')
  const [beat, setBeat] = useState<Beat>('typing')
  const [escrowValue, setEscrowValue] = useState(0)
  const [cursorPhase, setCursorPhase] = useState<CursorPhase>('hidden')

  const intent = INTENTS[intentIndex]!

  useEffect(() => {
    let cancelled = false
    const timeouts: ReturnType<typeof setTimeout>[] = []
    const schedule = (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        if (!cancelled) fn()
      }, ms)
      timeouts.push(t)
    }

    setTyped('')
    setBeat('typing')
    setEscrowValue(0)
    setCursorPhase('hidden')

    let charIndex = 0
    const typeNext = () => {
      charIndex++
      setTyped(intent.outcome.slice(0, charIndex))
      if (charIndex < intent.outcome.length) {
        schedule(typeNext, 26)
        return
      }

      schedule(() => setBeat('params'), 500)
      schedule(() => setCursorPhase('move'), 1400)
      schedule(() => setCursorPhase('click'), 1950)
      schedule(() => setBeat('submitted'), 2000)
      schedule(() => setCursorPhase('hidden'), 2350)
      schedule(() => setBeat('escrow'), 2700)
      schedule(() => {
        const steps = 18
        for (let s = 1; s <= steps; s++) {
          schedule(() => setEscrowValue(Math.round((intent.escrow / steps) * s)), s * 22)
        }
      }, 2700)
      schedule(() => setBeat('broadcast'), 3500)
      schedule(() => setIntentIndex((i) => (i + 1) % INTENTS.length), 6800)
    }
    schedule(typeNext, 450)

    return () => {
      cancelled = true
      timeouts.forEach(clearTimeout)
    }
  }, [intentIndex])

  const showEscrow = beat === 'escrow' || beat === 'broadcast'

  return (
    <div
      className="relative h-[340px] w-full overflow-hidden rounded-2xl md:h-[380px]"
      style={{ background: '#e8e8ec' }}
    >
      <AmbientBlob color="rgba(99,102,241,0.32)" size={220} top="12%" left="4%" duration={11} />
      <AmbientBlob
        color="rgba(200,150,90,0.22)"
        size={180}
        top="40%"
        right="4%"
        duration={14}
        delay={2}
      />
      <div
        className="pointer-events-none absolute rounded-full"
        style={{
          width: 300,
          height: 200,
          background: 'rgba(255,255,255,0.22)',
          filter: 'blur(80px)',
          top: '0%',
          left: '20%',
        }}
      />
      <div className="relative z-10 flex h-full w-full items-center justify-center">
        <div className="w-full max-w-sm px-5">
          <AnimatePresence mode="wait">
            {!showEscrow ? (
              <motion.div
                key="composer"
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.35, ease: 'easeOut' }}
              >
                <GlassPanel borderRadius={16}>
                  <div className="relative p-4">
                    <div className="text-muted-foreground/60 text-[10px] font-medium">
                      Express outcome
                    </div>
                    <div className="text-foreground mt-2 min-h-[2.5rem] font-sans text-sm leading-snug">
                      {typed}
                      {beat === 'typing' && (
                        <span className="bg-foreground/50 ml-0.5 inline-block h-4 w-[2px] animate-pulse align-middle" />
                      )}
                    </div>

                    {beat !== 'typing' && (
                      <>
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {intent.params.map((param, i) => (
                            <motion.div
                              key={param.label}
                              initial={{ opacity: 0, y: 6, scale: 0.9 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              transition={{ delay: i * 0.1, duration: 0.3 }}
                              className="border-border bg-muted/60 text-muted-foreground rounded-full border px-2.5 py-1 font-sans text-[10px]"
                            >
                              {param.label} · {param.value}
                            </motion.div>
                          ))}
                        </div>
                        <motion.div
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: 0.3, duration: 0.3 }}
                          className="mt-2 inline-block rounded-full bg-black/5 px-2 py-0.5 font-sans text-[10px] tabular-nums text-black/50"
                        >
                          {intent.escrow.toLocaleString()} USDC escrowed
                        </motion.div>
                      </>
                    )}

                    <motion.div
                      animate={{ scale: beat === 'submitted' ? [1, 0.94, 1] : 1 }}
                      transition={{ duration: 0.4 }}
                      className="bg-foreground text-background mt-4 rounded-lg py-2 text-center font-sans text-xs font-medium"
                    >
                      Submit intent
                    </motion.div>

                    <AnimatePresence>
                      {cursorPhase !== 'hidden' && (
                        <motion.div
                          key="cursor"
                          className="pointer-events-none absolute z-20"
                          initial={{ opacity: 0, left: '22%', top: '28%' }}
                          animate={{ opacity: 1, left: '80%', top: '93%' }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.55, ease: 'easeInOut' }}
                        >
                          <motion.div
                            animate={{ scale: cursorPhase === 'click' ? [1, 0.75, 1] : 1 }}
                            transition={{ duration: 0.25 }}
                          >
                            <MousePointer2
                              className="text-foreground h-4 w-4 -rotate-12 drop-shadow"
                              fill="currentColor"
                            />
                          </motion.div>
                          {cursorPhase === 'click' && (
                            <motion.span
                              className="absolute -inset-2 rounded-full border-2"
                              style={{ borderColor: '#6366f1' }}
                              initial={{ scale: 0.3, opacity: 0.8 }}
                              animate={{ scale: 1.7, opacity: 0 }}
                              transition={{ duration: 0.5, ease: 'easeOut' }}
                            />
                          )}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </GlassPanel>
              </motion.div>
            ) : (
              <motion.div
                key="escrow"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4, ease: 'easeOut' }}
              >
                <GlassPanel borderRadius={16}>
                  <div className="p-5 text-center">
                    <motion.div
                      initial={{ rotate: -18, scale: 0.8 }}
                      animate={{ rotate: 0, scale: 1 }}
                      transition={{ type: 'spring', stiffness: 260, damping: 16 }}
                      className="bg-brand/10 text-brand mx-auto flex h-9 w-9 items-center justify-center rounded-full"
                    >
                      <Lock className="h-4 w-4" strokeWidth={2} />
                    </motion.div>
                    <div className="text-foreground mt-3 font-sans text-lg font-semibold tabular-nums">
                      ${escrowValue.toLocaleString()}
                    </div>
                    <div className="text-muted-foreground/60 text-[10px]">
                      USDC locked in escrow
                    </div>

                    <AnimatePresence>
                      {beat === 'broadcast' && (
                        <motion.div
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          className="border-border bg-muted/60 mx-auto mt-4 flex w-fit items-center gap-1.5 rounded-full border px-3 py-1"
                        >
                          <Radio className="text-brand h-3 w-3" strokeWidth={2} />
                          <span className="text-muted-foreground font-sans text-[10px]">
                            Broadcasting to agent network
                          </span>
                          <motion.span
                            className="bg-brand h-1.5 w-1.5 rounded-full"
                            animate={{ opacity: [1, 0.3, 1] }}
                            transition={{ duration: 1, repeat: Infinity }}
                          />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </GlassPanel>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
