'use client'

import { motion } from 'framer-motion'
import { FeatureCard } from './how-it-works/feature-card'
import { IntentComposerScene } from './how-it-works/scenes/intent-composer-scene'
import { AgentRaceScene } from './how-it-works/scenes/agent-race-scene'
import { ExecutionScoreScene } from './how-it-works/scenes/execution-score-scene'
import { SettlementScene } from './how-it-works/scenes/settlement-scene'

const EASE = [0.25, 0.46, 0.45, 0.94] as const

export function HowItWorks() {
  return (
    <section id="how-it-works" className="relative overflow-hidden px-6 py-24 md:py-32">
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute inset-x-0 bottom-14 top-14 bg-[#D8D8D8] md:bottom-20 md:top-20" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/Top.png"
          alt=""
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-16 w-full object-fill md:h-24"
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/Top.png"
          alt=""
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-16 w-full object-fill md:h-24"
          style={{ transform: 'scaleY(-1) scaleX(-1)' }}
        />
      </div>

      <div className="mx-auto max-w-3xl text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.6, ease: EASE }}
          className="text-muted-foreground/60 font-sans text-xs"
        ></motion.div>

        <motion.h2
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.7, delay: 0.12, ease: EASE }}
          className="font-display mt-4 text-4xl leading-tight tracking-tight md:text-5xl"
        >
          One intent in.
          <br />A single best <em className="font-serif italic">execution</em> out.
        </motion.h2>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.6, delay: 0.24, ease: EASE }}
          className="text-muted-foreground/80 mx-auto mt-5 max-w-xl font-sans"
        >
          Every agent sees the same intent. They compete in the open. Only the best execution
          settles on-chain.
        </motion.p>
      </div>

      <div className="mx-auto mt-16 grid max-w-7xl grid-cols-1 gap-6 md:mt-20 lg:grid-cols-12 lg:gap-7">
        <FeatureCard
          title="Express the outcome"
          description="Skip the order form. State what you want and USDC locks into escrow instantly."
          className="lg:col-span-7"
          index={0}
        >
          <IntentComposerScene />
        </FeatureCard>

        <FeatureCard
          title="Agents race to execute"
          description="Four autonomous strategies compete in a 30-second window, live."
          className="lg:col-span-5"
          index={1}
        >
          <AgentRaceScene />
        </FeatureCard>

        <FeatureCard
          title="Best execution wins"
          description="Every proposal is scored on price and slippage. Only the winner executes."
          className="lg:col-span-5"
          index={2}
        >
          <ExecutionScoreScene />
        </FeatureCard>

        <FeatureCard
          title="Settled on Arc L1"
          description="Execution is validated on-chain, USDC settles, and reputation updates."
          className="lg:col-span-7"
          index={3}
        >
          <SettlementScene />
        </FeatureCard>
      </div>
    </section>
  )
}
