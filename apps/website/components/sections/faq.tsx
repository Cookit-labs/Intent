'use client'

import * as Accordion from '@radix-ui/react-accordion'
import { motion } from 'framer-motion'
import { Plus } from 'lucide-react'

const EASE = [0.25, 0.46, 0.45, 0.94] as const

const FAQS = [
  {
    question: 'What is Intent?',
    answer:
      'Intent is a stablecoin-native execution marketplace. Instead of placing a manual order, you describe the outcome you want — accumulate a position, hedge exposure, rebalance capital — and autonomous agents compete to deliver it.',
  },
  {
    question: 'How is this different from a normal trade or limit order?',
    answer:
      'A limit order tells the market exactly how to fill you. An intent only states the outcome you want — agents compete to find the best way to get there, and only the best-performing proposal ever executes.',
  },
  {
    question: 'Who are the agents, and how do they decide what to do?',
    answer:
      'Four agent types compete on every intent — TWAP, Momentum, Shadow and Arbitrage — each running a different execution strategy. They reason over the same intent independently and submit a priced proposal within the competition window.',
  },
  {
    question: 'What happens to my funds while agents compete?',
    answer:
      'Your USDC is locked in escrow the moment you submit an intent. It never leaves escrow until a winning proposal is selected and executed — no agent has custody of your funds during the competition.',
  },
  {
    question: 'How is the winning agent chosen?',
    answer:
      'Every proposal is scored on execution price and slippage. Only the highest-scoring proposal gets execution rights; the rest are discarded and never touch your funds.',
  },
  {
    question: 'What happens if no agent submits a good proposal?',
    answer:
      'If the competition window closes without a proposal that meets your constraints, the intent expires and your USDC is released from escrow — nothing executes.',
  },
  {
    question: 'Why settle on Arc L1?',
    answer:
      'Execution, escrow and reputation all need to be independently verifiable. Arc L1 gives every agent constrained, auditable on-chain permissions, so a winning proposal can be executed and checked without trusting the agent itself.',
  },
  {
    question: 'How is agent reputation tracked?',
    answer:
      "Every execution updates the winning agent's on-chain reputation score based on realized performance, so track records are public and compounding, not self-reported.",
  },
] as const

export function Faq() {
  return (
    <section id="faq" className="relative px-6 py-24 md:py-32">
      <div className="mx-auto max-w-3xl text-center">
        <motion.h2
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.7, ease: EASE }}
          className="font-sans text-4xl leading-tight tracking-tight md:text-5xl"
        >
          Frequently <span className="font-serif italic">asked</span> <span>questions</span>
        </motion.h2>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.6, delay: 0.12, ease: EASE }}
          className="text-muted-foreground/80 mx-auto mt-5 max-w-xl font-sans"
        >
          Everything you need to know about how intents, agents and settlement work.
        </motion.p>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.2 }}
        transition={{ duration: 0.7, delay: 0.2, ease: EASE }}
        className="mx-auto mt-14 max-w-2xl md:mt-16"
      >
        <Accordion.Root type="single" collapsible className="flex flex-col">
          {FAQS.map((faq, i) => (
            <Accordion.Item
              key={faq.question}
              value={`item-${i}`}
              className="border-border border-b first:border-t"
            >
              <Accordion.Header>
                <Accordion.Trigger className="text-foreground hover:text-brand group flex w-full items-center justify-between gap-4 py-5 text-left font-sans text-sm font-medium transition-colors md:text-base">
                  {faq.question}
                  <Plus className="text-muted-foreground group-data-[state=open]:text-brand h-4 w-4 shrink-0 transition-transform duration-300 group-data-[state=open]:rotate-45" />
                </Accordion.Trigger>
              </Accordion.Header>
              <Accordion.Content className="data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down overflow-hidden">
                <p className="text-muted-foreground/80 pb-5 pr-8 font-sans text-sm leading-relaxed">
                  {faq.answer}
                </p>
              </Accordion.Content>
            </Accordion.Item>
          ))}
        </Accordion.Root>
      </motion.div>
    </section>
  )
}
