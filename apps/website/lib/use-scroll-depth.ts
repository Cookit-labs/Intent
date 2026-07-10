'use client'

import { useEffect, useState } from 'react'

/**
 * Fires once when the user scrolls past `threshold` (0–1) of the document height.
 * Works alongside Lenis smooth scroll — native scroll events still fire.
 */
export function useScrollDepth(threshold = 0.5): boolean {
  const [reached, setReached] = useState(false)

  useEffect(() => {
    if (reached) return

    let ticking = false

    const check = () => {
      ticking = false
      const scrolled = window.scrollY + window.innerHeight
      const total = document.documentElement.scrollHeight
      if (total > 0 && scrolled / total >= threshold) {
        setReached(true)
      }
    }

    const onScroll = () => {
      if (!ticking) {
        ticking = true
        window.requestAnimationFrame(check)
      }
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    check()

    return () => window.removeEventListener('scroll', onScroll)
  }, [threshold, reached])

  return reached
}
