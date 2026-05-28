'use client'

import { useEffect } from 'react'

// TODO: initialize Lenis smooth scroll
export function SmoothScrollProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // TODO: import and init Lenis
    // const lenis = new Lenis()
    // function raf(time: number) { lenis.raf(time); requestAnimationFrame(raf) }
    // requestAnimationFrame(raf)
  }, [])

  return <>{children}</>
}