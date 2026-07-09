'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { motion } from 'framer-motion'

interface GradientBorderProps {
  children: React.ReactNode
  className?: string
  radius?: number
  thickness?: number
  duration?: number
  cometLength?: number
}

function roundedRectPath(w: number, h: number, r: number) {
  const rad = Math.max(Math.min(r, w / 2, h / 2), 0)
  return [
    `M ${rad} 0`,
    `L ${w - rad} 0`,
    `A ${rad} ${rad} 0 0 1 ${w} ${rad}`,
    `L ${w} ${h - rad}`,
    `A ${rad} ${rad} 0 0 1 ${w - rad} ${h}`,
    `L ${rad} ${h}`,
    `A ${rad} ${rad} 0 0 1 0 ${h - rad}`,
    `L 0 ${rad}`,
    `A ${rad} ${rad} 0 0 1 ${rad} 0`,
    'Z',
  ].join(' ')
}

/**
 * A thin neutral border with a single indigo/orange/green comet arc that
 * travels continuously around the perimeter (snake-style). The outline is
 * built as an explicit rounded-rect path (rather than <rect rx>) so the
 * pathLength=100 normalization distributes evenly across corners instead of
 * bunching where basic-shape-to-path conversion quirks show up.
 */
export function GradientBorder({
  children,
  className = '',
  radius = 16,
  thickness = 1.5,
  duration = 6,
  cometLength = 26,
}: GradientBorderProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const gradId = useId().replace(/:/g, '')
  const glowId = useId().replace(/:/g, '')

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const inset = thickness / 2
  const w = Math.max(size.width - thickness, 0)
  const h = Math.max(size.height - thickness, 0)
  const pathD = roundedRectPath(w, h, radius)
  const dashArray = `${cometLength} ${100 - cometLength}`
  const transition = { duration, repeat: Infinity, ease: 'linear' as const }

  return (
    <div ref={ref} className={`relative ${className}`} style={{ borderRadius: `${radius}px` }}>
      {size.width > 0 && size.height > 0 && (
        <svg
          width={size.width}
          height={size.height}
          viewBox={`0 0 ${size.width} ${size.height}`}
          className="pointer-events-none absolute inset-0 overflow-visible"
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#6366f1" />
              <stop offset="50%" stopColor="#f97316" />
              <stop offset="100%" stopColor="#16a34a" />
            </linearGradient>
            <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3" />
            </filter>
          </defs>
          <g transform={`translate(${inset}, ${inset})`}>
            <path
              d={pathD}
              fill="none"
              stroke="black"
              strokeOpacity={0.07}
              strokeWidth={thickness}
            />
            <motion.path
              d={pathD}
              fill="none"
              stroke={`url(#${gradId})`}
              strokeWidth={thickness * 3}
              strokeLinecap="round"
              pathLength={100}
              strokeDasharray={dashArray}
              opacity={0.45}
              filter={`url(#${glowId})`}
              animate={{ strokeDashoffset: [0, -100] }}
              transition={transition}
            />
            <motion.path
              d={pathD}
              fill="none"
              stroke={`url(#${gradId})`}
              strokeWidth={thickness}
              strokeLinecap="round"
              pathLength={100}
              strokeDasharray={dashArray}
              animate={{ strokeDashoffset: [0, -100] }}
              transition={transition}
            />
          </g>
        </svg>
      )}
      <div className="relative h-full w-full" style={{ borderRadius: `${radius}px` }}>
        {children}
      </div>
    </div>
  )
}
