'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUpRight, Menu, X } from 'lucide-react'
import { useState } from 'react'

const NAV_LINKS = [
  { label: 'Docs', href: '#' },
  { label: 'Agents', href: '#' },
  { label: 'Marketplace', href: '#' },
]

export function Navbar() {
  const [open, setOpen] = useState(false)

  return (
    <nav className="border-border bg-background/80 fixed left-0 right-0 top-0 z-50 border-b backdrop-blur-md">
      <div className="mx-auto flex h-16 items-center justify-between px-6 md:max-w-[1600px]">
        <span className="font-sans text-lg font-bold tracking-tight">Intent</span>

        <div className="flex items-center gap-4 md:gap-6">
          <div className="hidden items-center gap-6 md:flex">
            {NAV_LINKS.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="text-muted-foreground hover:text-foreground font-sans text-sm transition-colors"
              >
                {link.label}
              </a>
            ))}
          </div>
          <a
            href="#"
            className="bg-foreground text-background hidden items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90 sm:inline-flex"
          >
            Book a Demo
            <ArrowUpRight className="h-4 w-4" strokeWidth={2} />
          </a>

          {/* Mobile menu toggle */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            className="text-foreground hover:bg-muted -mr-2 inline-flex h-10 w-10 items-center justify-center rounded-full transition-colors md:hidden"
          >
            {open ? (
              <X className="h-5 w-5" strokeWidth={2} />
            ) : (
              <Menu className="h-5 w-5" strokeWidth={2} />
            )}
          </button>
        </div>
      </div>

      {/* Mobile menu panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            key="mobile-menu"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="border-border bg-background overflow-hidden border-b md:hidden"
          >
            <div className="flex flex-col gap-1 px-6 py-4">
              {NAV_LINKS.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="text-foreground hover:bg-muted -mx-2 rounded-lg px-2 py-2.5 font-sans text-base transition-colors"
                >
                  {link.label}
                </a>
              ))}
              <a
                href="#"
                onClick={() => setOpen(false)}
                className="bg-foreground text-background mt-2 inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-2.5 text-sm font-medium transition-opacity hover:opacity-90"
              >
                Book a Demo
                <ArrowUpRight className="h-4 w-4" strokeWidth={2} />
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  )
}
