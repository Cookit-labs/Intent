'use client'

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { BadgeCheck } from 'lucide-react'
import { GlassPanel } from '../glass-panel'
import { AmbientBlob } from '../ambient-blob'

const STEPS = ['Execution submitted', 'Validated on Arc L1', 'USDC settled', 'Reputation updated']
const SEGMENT_LEFT = [12.5, 37.5, 62.5]
const VERIFIED_BLUE = '#1D9BF0'

export function SettlementScene() {
  const [cycleId, setCycleId] = useState(0)
  const [doneStep, setDoneStep] = useState(-1)
  const [settledAmount, setSettledAmount] = useState(0)

  useEffect(() => {
    let cancelled = false
    const timeouts: ReturnType<typeof setTimeout>[] = []
    const schedule = (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        if (!cancelled) fn()
      }, ms)
      timeouts.push(t)
    }

    setDoneStep(-1)
    setSettledAmount(0)

    schedule(() => setDoneStep(0), 300)
    schedule(() => setDoneStep(1), 1500)
    schedule(() => setDoneStep(2), 2900)
    schedule(() => {
      const steps = 16
      for (let s = 1; s <= steps; s++) {
        schedule(() => setSettledAmount(Math.round((10000 / steps) * s)), s * 20)
      }
    }, 2900)
    schedule(() => setDoneStep(3), 4300)
    schedule(() => setCycleId((c) => c + 1), 8600)

    return () => {
      cancelled = true
      timeouts.forEach(clearTimeout)
    }
  }, [cycleId])

  return (
    <div
      className="relative h-[200px] w-full overflow-hidden rounded-2xl md:h-[220px] 2xl:h-[260px]"
      style={{ background: '#e8e8ec' }}
    >
      <AmbientBlob color="rgba(29,155,240,0.30)" size={200} top="8%" left="12%" duration={13} />
      <AmbientBlob
        color="rgba(99,102,241,0.24)"
        size={150}
        bottom="6%"
        right="6%"
        duration={16}
        delay={2}
      />
      <div
        className="pointer-events-none absolute rounded-full"
        style={{
          width: 280,
          height: 160,
          background: 'rgba(255,255,255,0.22)',
          filter: 'blur(80px)',
          top: '0%',
          left: '30%',
        }}
      />
      <div className="relative z-10 flex h-full w-full items-center px-4 md:px-6">
        <GlassPanel borderRadius={16} className="w-full">
          <div className="flex w-full flex-col justify-center px-4 py-6 md:px-8">
            <div className="relative z-10 flex items-start justify-between">
              {SEGMENT_LEFT.map((left, i) => (
                <div
                  key={left}
                  className="bg-border absolute top-3.5 h-[2px]"
                  style={{ left: `${left}%`, width: '25%' }}
                >
                  <motion.div
                    className="h-full origin-left"
                    style={{ background: VERIFIED_BLUE }}
                    animate={{ scaleX: doneStep > i ? 1 : 0 }}
                    transition={{ duration: 0.7, ease: 'easeInOut' }}
                  />
                  <motion.span
                    className="absolute -top-[3px] h-2 w-2 rounded-full"
                    style={{ background: VERIFIED_BLUE }}
                    animate={{
                      left: doneStep > i ? '100%' : '0%',
                      opacity: doneStep > i ? [1, 1, 0] : 0,
                    }}
                    transition={{ duration: 0.7, ease: 'easeInOut' }}
                  />
                </div>
              ))}

              {STEPS.map((label, i) => {
                const done = doneStep >= i
                const justCompleted = doneStep === i

                return (
                  <div
                    key={label}
                    className="relative z-10 flex flex-1 flex-col items-center text-center"
                  >
                    <div className="relative flex h-7 w-7 items-center justify-center">
                      <AnimatePresence>
                        {justCompleted && (
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

                    <div className="text-muted-foreground/70 mt-2 max-w-[9ch] font-sans text-[9px] leading-tight md:text-[9.5px]">
                      {label}
                    </div>

                    <AnimatePresence>
                      {i === 1 && done && (
                        <motion.div
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="text-muted-foreground mt-1 font-sans text-[9px] tabular-nums"
                        >
                          0x8f21…d91c
                        </motion.div>
                      )}
                      {i === 2 && done && (
                        <motion.div
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="text-foreground mt-1 font-sans text-[9px] tabular-nums"
                        >
                          ${settledAmount.toLocaleString()}
                        </motion.div>
                      )}
                      {i === 3 && done && (
                        <motion.div
                          initial={{ opacity: 0, scale: 0.7 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ type: 'spring', stiffness: 300, damping: 14 }}
                          className="text-success mt-1 font-sans text-[10px] font-semibold"
                        >
                          +12
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )
              })}
            </div>

            <AnimatePresence>
              {doneStep >= 3 && (
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ delay: 0.4, duration: 0.4 }}
                  className="mt-5 text-center font-sans text-[10px] tabular-nums text-black/40"
                >
                  settled on-chain · 0x8f21…d91c
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </GlassPanel>
      </div>
    </div>
  )
}
