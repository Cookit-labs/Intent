'use client'

import { motion } from 'framer-motion'
import { EcosystemFilm } from './ecosystem-film'

const EASE = [0.25, 0.46, 0.45, 0.94] as const

export function Ecosystem() {
  return (
    <section id="ecosystem" className="relative overflow-hidden px-6 py-24 md:py-28">
      <div className="mx-auto max-w-3xl text-center">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.6, ease: EASE }}
          className="text-muted-foreground/60 font-sans text-xs tracking-wide"
        >
          The settlement layer
        </motion.div>

        <motion.h2
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.7, delay: 0.12, ease: EASE }}
          className="font-display mt-4 text-4xl leading-tight tracking-tight 2xl:text-5xl"
        >
          Every winning execution becomes activity on <em className="font-serif italic">Arc</em>.
        </motion.h2>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.6, delay: 0.24, ease: EASE }}
          className="text-muted-foreground/80 mx-auto mt-5 max-w-xl font-sans"
        >
          Follow one intent the whole distance — locked in escrow, fought over by agents, and
          settled on Arc L1. Every resolution adds real volume, real finality, and real reputation
          to the network.
        </motion.p>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 28 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.2 }}
        transition={{ duration: 0.7, delay: 0.3, ease: EASE }}
        className="mx-auto mt-16 max-w-4xl md:mt-20 2xl:max-w-5xl"
      >
        <EcosystemFilm />
      </motion.div>
    </section>
  )
}
