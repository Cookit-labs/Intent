'use client'

import { ChainMark, cn } from '@intent/ui'
import { BarChart3, Boxes, History, Settings, Sparkles, Vault, Wallet } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { useChain } from '../../providers/chain-provider'

const nav = [
  { href: '/intents', label: 'Intents', icon: Sparkles },
  { href: '/agents', label: 'Agents', icon: Wallet },
  { href: '/apps', label: 'Apps', icon: Boxes },
  { href: '/analytics', label: 'Analytics', icon: BarChart3, soon: true },
  { href: '/history', label: 'History', icon: History },
  { href: '/vault', label: 'Vault', icon: Vault, soon: true },
  { href: '/settings', label: 'Settings', icon: Settings, soon: true },
] as const

export function Sidebar({
  onNavigate,
  className,
}: {
  /** Called when a link is followed, so a mobile drawer can close itself. */
  onNavigate?: () => void
  className?: string
} = {}): JSX.Element {
  const pathname = usePathname()
  const { slug, descriptor } = useChain()

  return (
    <aside
      className={cn(
        'border-border bg-surface-elevated flex h-full w-60 shrink-0 flex-col border-r',
        className
      )}
    >
      <div className="flex h-16 items-center px-6">
        <span className="font-display text-lg font-semibold tracking-tight">Intent</span>
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
        {nav.map((item) => {
          const { href: path, label, icon: Icon } = item
          const soon = 'soon' in item && item.soon
          const href = `/${slug}${path}`
          const active = pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              // Closes the drawer on mobile. Without it the menu stays open
              // over the page the user just asked for.
              onClick={() => onNavigate?.()}
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
        <ChainMark chain={slug} className="h-[18px] w-[18px]" />
        <p className="text-muted-foreground text-[11px]">Powered by {descriptor.name} network</p>
      </div>
    </aside>
  )
}
