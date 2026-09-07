'use client'

import { motion } from 'framer-motion'

import { LaunchDapp } from '../layout/launch-dapp'

const EASE = [0.25, 0.46, 0.45, 0.94] as const

// Headline options — swap HEADLINE to taste:
// 1. "Your first intent is one click away."
// 2. "Stop placing orders. Start stating outcomes."
// 3. "The best execution finds you."
const HEADLINE = 'Your first intent is one click away.'

export function FinalCta() {
  return (
    <section id="final-cta" className="relative px-6 py-24 md:py-28 2xl:py-32">
      <div className="mx-auto max-w-3xl text-center">
        <motion.h2
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.7, ease: EASE }}
          className="font-display text-4xl leading-tight tracking-tight 2xl:text-5xl"
        >
          {HEADLINE}
        </motion.h2>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.6, delay: 0.15, ease: EASE }}
        >
          <LaunchDapp size="lg" className="mt-10 inline-block text-left" />
        </motion.div>
      </div>
    </section>
  )
}
