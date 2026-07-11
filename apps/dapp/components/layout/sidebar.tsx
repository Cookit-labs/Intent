'use client'

import { cn } from '@intent/ui'
import {
  BarChart3,
  Boxes,
  Gavel,
  History,
  LayoutDashboard,
  Settings,
  Sparkles,
  Trophy,
  Vault,
  Wallet,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const nav = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/intents', label: 'Intents', icon: Sparkles },
  { href: '/competitions', label: 'Competitions', icon: Gavel },
  { href: '/agents', label: 'Agents', icon: Wallet },
  { href: '/apps', label: 'Apps', icon: Boxes },
  { href: '/leaderboard', label: 'Leaderboard', icon: Trophy },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/history', label: 'History', icon: History },
  { href: '/vault', label: 'Vault', icon: Vault },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const

export function Sidebar(): JSX.Element {
  const pathname = usePathname()

  return (
    <aside className="border-border bg-surface-elevated flex h-full w-60 shrink-0 flex-col border-r">
      <div className="flex h-16 items-center gap-2 px-6">
        <span className="font-display text-lg font-semibold tracking-tight">Intent</span>
        <span className="border-border text-muted-foreground rounded border px-1.5 py-0.5 text-[10px] tracking-wide">
          Terminal
        </span>
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
        {nav.map(({ href, label, icon: Icon }) => {
          const active = href === '/' ? pathname === '/' : pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-brand text-brand-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          )
        })}
      </nav>

      <div className="border-border border-t px-6 py-4">
        <p className="text-muted-foreground font-mono text-[11px] leading-relaxed">
          Settling in USDC on Arc.
          <br />
          Non-custodial by design.
        </p>
      </div>
    </aside>
  )
}
