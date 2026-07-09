'use client'

import { motion } from 'framer-motion'

interface FeatureCardProps {
  title: string
  description: string
  children: React.ReactNode
  className?: string
  index?: number
}

export function FeatureCard({
  title,
  description,
  children,
  className = '',
  index = 0,
}: FeatureCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 36 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.7, delay: index * 0.12, ease: [0.25, 0.46, 0.45, 0.94] }}
      className={`border-border bg-card group flex flex-col overflow-hidden rounded-[32px] border shadow-[0_16px_40px_-12px_rgba(0,0,0,0.08)] transition-all duration-500 hover:-translate-y-0.5 hover:shadow-[0_24px_56px_-16px_rgba(0,0,0,0.14)] md:rounded-[40px] ${className}`}
    >
      <div className="px-6 pb-3 pt-6 md:px-9 md:pb-4 md:pt-9">
        <h3 className="text-foreground font-sans text-lg font-semibold tracking-tight md:text-xl">
          {title}
        </h3>
        <p className="text-muted-foreground/80 mt-2 max-w-[36ch] font-sans text-sm leading-relaxed">
          {description}
        </p>
      </div>
      <div className="flex flex-1 items-center justify-center px-4 pb-4 md:px-7 md:pb-7">
        {children}
      </div>
    </motion.div>
  )
}
