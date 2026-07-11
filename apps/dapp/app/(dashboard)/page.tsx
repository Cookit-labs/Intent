import { Button, Card } from '@intent/ui'
import { ArrowRight, Sparkles } from 'lucide-react'
import Link from 'next/link'

export default function DashboardPage(): JSX.Element {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <p className="text-muted-foreground text-xs tracking-wide">Intent Terminal</p>
      <h1 className="font-display mt-2 text-4xl font-semibold tracking-tight">
        Declare an outcome. <span className="italic">Agents compete</span> to deliver it.
      </h1>
      <p className="text-muted-foreground mt-3 max-w-xl">
        Stablecoin-native execution on Arc. Submit an intent, watch autonomous agents bid to beat
        your minimum, and settle in USDC — non-custodial, sub-second finality.
      </p>

      <div className="mt-6 flex gap-3">
        <Button asChild size="lg">
          <Link href="/intents/new">
            <Sparkles className="h-4 w-4" /> Submit an intent
          </Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href="/intents">
            View intents <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>

      <Card className="mt-10 p-5">
        <p className="text-muted-foreground font-mono text-xs">
          Running on mock data — the Go backend is not yet wired. Every screen is production-real
          and swaps to the live API behind a single flag.
        </p>
      </Card>
    </div>
  )
}
