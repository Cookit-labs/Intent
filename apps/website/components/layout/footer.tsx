'use client'

import { motion } from 'framer-motion'
import { Github, MessageCircle, Twitter } from 'lucide-react'

const NAV_LINKS = [
  { label: 'Docs', href: '#' },
  { label: 'Agents', href: '#' },
  { label: 'Marketplace', href: '#' },
]

const SOCIALS = [
  { label: 'X / Twitter', href: '#', Icon: Twitter },
  { label: 'GitHub', href: '#', Icon: Github },
  { label: 'Discord', href: '#', Icon: MessageCircle },
]

export function Footer() {
  return (
    <motion.footer
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.6 }}
    >
      <div className="mx-auto max-w-7xl px-6 py-10">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <span className="font-sans text-sm font-medium tracking-tight">Intent</span>

          <div className="flex items-center gap-8">
            <div className="flex items-center gap-6">
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

            <div className="flex items-center gap-4">
              {SOCIALS.map(({ label, href, Icon }) => (
                <a
                  key={label}
                  href={href}
                  aria-label={label}
                  className="text-black/40 transition-colors hover:text-black/70"
                >
                  <Icon className="h-4 w-4" />
                </a>
              ))}
            </div>
          </div>
        </div>

        <div className="text-muted-foreground/50 mt-8 font-sans text-xs">
          © 2026 Intent. Built by Suncrest Labs.
        </div>
      </div>
    </motion.footer>
  )
}
