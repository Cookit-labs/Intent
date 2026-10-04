import { ArrowUp, BarChart3, Bot, History, Sparkles, Wifi } from 'lucide-react'

/**
 * The mobile app as it is meant to look, drawn at a real phone's width.
 *
 * Laid out at 390 by 820 and scaled down by whatever holds it, so type and
 * spacing are the ones a phone would use rather than ones shrunk to fit a
 * thumbnail. It uses the app's own tokens, so it follows the theme the same
 * way the real screens do.
 */

const AGENTS = [
  { name: 'Aster', quote: '6.214', best: true },
  { name: 'Vega', quote: '6.198', best: false },
  { name: 'Orrin', quote: '6.171', best: false },
]

const TABS = [
  { label: 'Intents', Icon: Sparkles, active: true },
  { label: 'Agents', Icon: Bot, active: false },
  { label: 'Apps', Icon: BarChart3, active: false },
  { label: 'History', Icon: History, active: false },
]

export function PhoneScreen(): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="bg-background text-foreground relative flex h-[820px] w-[390px] flex-col overflow-hidden"
    >
      <div className="from-brand/25 pointer-events-none absolute inset-x-0 top-0 h-72 bg-gradient-to-b to-transparent" />

      <div className="relative flex items-center justify-between px-8 pt-4 text-[15px] font-medium">
        <span>9:41</span>
        <span className="flex items-center gap-1.5">
          <Wifi className="h-4 w-4" strokeWidth={2} />
          <span className="border-foreground/70 relative block h-3 w-6 rounded-[4px] border">
            <span className="bg-foreground/80 absolute inset-[2px] right-[5px] rounded-[2px]" />
          </span>
        </span>
      </div>

      <div className="relative mt-5 flex items-center justify-between px-5">
        <span className="border-border bg-card inline-flex items-center gap-2 rounded-full border py-1.5 pl-2 pr-3 text-sm">
          <span className="bg-brand text-brand-foreground flex h-5 w-5 items-center justify-center rounded-full text-[10px]">
            S
          </span>
          Stellar
        </span>
        <span className="bg-muted text-muted-foreground flex h-9 w-9 items-center justify-center rounded-full text-xs">
          GA
        </span>
      </div>

      <div className="relative mt-9 px-6">
        <p className="text-muted-foreground text-sm">Balance</p>
        <p className="mt-1 text-[44px] leading-none tracking-tight">$1,248.30</p>
        <p className="text-success mt-2 text-sm">+2.4% today</p>
      </div>

      <div className="relative mt-8 px-5">
        <div className="border-border bg-card rounded-3xl border p-4">
          <p className="text-[17px] leading-snug">Swap 50 XLM to USDC at the best price</p>
          <div className="mt-6 flex items-center justify-between">
            <span className="text-muted-foreground text-sm">Up to $50 a trade</span>
            <span className="bg-brand text-brand-foreground flex h-10 w-10 items-center justify-center rounded-full">
              <ArrowUp className="h-5 w-5" />
            </span>
          </div>
        </div>
      </div>

      <div className="relative mt-7 px-6">
        <p className="text-muted-foreground text-sm">Agents competing</p>
        <ul className="mt-3 flex flex-col gap-2.5">
          {AGENTS.map((agent) => (
            <li
              key={agent.name}
              className={`flex items-center justify-between rounded-2xl border px-4 py-3 ${
                agent.best ? 'border-brand/50 bg-brand/10' : 'border-border bg-card'
              }`}
            >
              <span className="flex items-center gap-3">
                <span className="bg-muted flex h-8 w-8 items-center justify-center rounded-full text-xs">
                  {agent.name.charAt(0)}
                </span>
                <span className="text-[15px]">{agent.name}</span>
              </span>
              <span className="flex items-center gap-2 text-[15px]">
                {agent.best ? (
                  <span className="bg-brand text-brand-foreground rounded-full px-2 py-0.5 text-[11px]">
                    Best
                  </span>
                ) : null}
                {agent.quote} USDC
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="border-border bg-card/90 absolute inset-x-0 bottom-0 flex items-start justify-around border-t px-4 pb-8 pt-3">
        {TABS.map(({ label, Icon, active }) => (
          <span
            key={label}
            className={`flex w-16 flex-col items-center gap-1 text-[11px] ${
              active ? 'text-brand' : 'text-muted-foreground'
            }`}
          >
            <Icon className="h-5 w-5" strokeWidth={active ? 2 : 1.75} />
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}
