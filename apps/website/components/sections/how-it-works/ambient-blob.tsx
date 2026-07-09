'use client'

import { motion } from 'framer-motion'

interface AmbientBlobProps {
  color: string
  size: number
  top?: string
  left?: string
  right?: string
  bottom?: string
  duration?: number
  delay?: number
}

export function AmbientBlob({
  color,
  size,
  top,
  left,
  right,
  bottom,
  duration = 9,
  delay = 0,
}: AmbientBlobProps) {
  return (
    <motion.div
      className="pointer-events-none absolute rounded-full"
      style={{
        width: size,
        height: size,
        top,
        left,
        right,
        bottom,
        background: color,
        filter: 'blur(48px)',
      }}
      animate={{
        x: [0, 24, -12, 0],
        y: [0, -18, 14, 0],
      }}
      transition={{ duration, delay, repeat: Infinity, ease: 'easeInOut' }}
    />
  )
}
