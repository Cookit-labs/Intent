import { ArrowUpRight } from 'lucide-react'

const NAV_LINKS = [
  { label: 'Docs', href: '#' },
  { label: 'Agents', href: '#' },
  { label: 'Marketplace', href: '#' },
]

export function Navbar() {
  return (
    <nav className="border-border bg-background/80 fixed left-0 right-0 top-0 z-50 h-16 border-b backdrop-blur-md">
      <div className="mx-auto flex h-full max-w-[1600px] items-center justify-between px-6">
        <span className="font-sans text-lg font-bold tracking-tight">Intent</span>

        {/* <div className="hidden items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground md:flex">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
          Arc L1 · Live
        </div> */}

        <div className="flex items-center gap-6">
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
            className="bg-foreground text-background rounded-full px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90"
          >
            Book a Demo
          </a>
        </div>
      </div>
    </nav>
  )
}
