'use client'

import { cn } from '@intent/ui'
import { BarChart3, Boxes, History, Settings, Sparkles, Vault, Wallet } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const nav = [
  { href: '/intents', label: 'Intents', icon: Sparkles },
  { href: '/agents', label: 'Agents', icon: Wallet },
  { href: '/apps', label: 'Apps', icon: Boxes },
  { href: '/analytics', label: 'Analytics', icon: BarChart3, soon: true },
  { href: '/history', label: 'History', icon: History, soon: true },
  { href: '/vault', label: 'Vault', icon: Vault, soon: true },
  { href: '/settings', label: 'Settings', icon: Settings, soon: true },
] as const

export function Sidebar(): JSX.Element {
  const pathname = usePathname()

  return (
    <aside className="border-border bg-surface-elevated flex h-full w-60 shrink-0 flex-col border-r">
      <div className="flex h-16 items-center px-6">
        <span className="font-display text-lg font-semibold tracking-tight">Intent</span>
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
        {nav.map((item) => {
          const { href, label, icon: Icon } = item
          const soon = 'soon' in item && item.soon
          const active = pathname.startsWith(href)
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
              {soon ? (
                <span
                  className={cn(
                    'ml-auto rounded border px-1.5 py-0.5 text-[10px] font-normal',
                    active ? 'border-brand-foreground/40' : 'border-border'
                  )}
                >
                  Soon
                </span>
              ) : null}
            </Link>
          )
        })}
      </nav>

      <div className="border-border flex items-center gap-2 border-t px-6 py-4">
        <Image src="/images/Arc.png" alt="Arc" width={18} height={18} className="rounded" />
        <p className="text-muted-foreground text-[11px]">Powered by Arc network</p>
      </div>
    </aside>
  )
}
