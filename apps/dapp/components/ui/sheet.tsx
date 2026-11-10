'use client'

import { cn } from '@intent/ui'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * A panel over the page for one focused task: the right edge on a wide screen, the bottom on a
 * phone, where a thumb can reach it. The page underneath stays where it was, so closing it puts
 * the person back exactly where they started.
 */
export function Sheet({
  open,
  onClose,
  label,
  children,
  className,
}: {
  open: boolean
  onClose: () => void
  /** What the panel is, for a screen reader. */
  label: string
  children: ReactNode
  className?: string
}): JSX.Element | null {
  const panel = useRef<HTMLDivElement | null>(null)
  const reduce = useReducedMotion()

  useEffect(() => {
    if (!open) return
    const before = document.activeElement as HTMLElement | null
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panel.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
      before?.focus?.()
    }
  }, [open, onClose])

  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-[60] flex items-end justify-end sm:items-start sm:p-3">
          <motion.button
            type="button"
            tabIndex={-1}
            aria-label="Close"
            onClick={onClose}
            className="bg-foreground/20 absolute inset-0 cursor-default backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce === true ? 0 : 0.18 }}
          />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            tabIndex={-1}
            className={cn(
              'bg-background relative flex max-h-[88vh] w-full flex-col overflow-y-auto rounded-t-[28px] shadow-[0_-12px_48px_-12px_rgb(0_0_0/0.25)] outline-none',
              'sm:max-h-[calc(100vh-24px)] sm:w-[420px] sm:rounded-[28px] sm:shadow-[0_24px_64px_-24px_rgb(0_0_0/0.35)]',
              className
            )}
            style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
            initial={reduce === true ? { opacity: 0 } : { opacity: 0, x: 24, y: 0 }}
            animate={{ opacity: 1, x: 0, y: 0 }}
            exit={reduce === true ? { opacity: 0 } : { opacity: 0, x: 24 }}
            transition={{ type: 'spring', stiffness: 420, damping: 38 }}
          >
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-muted-foreground hover:text-foreground hover:bg-muted/70 absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
            <span
              aria-hidden
              className="bg-border mx-auto mt-2.5 h-1 w-10 rounded-full sm:hidden"
            />
            {children}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body
  )
}
