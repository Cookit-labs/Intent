import { Loader2 } from 'lucide-react'

/** Shown inside the frame the moment a link is followed, while the next screen renders. */
export default function ChainLoading(): JSX.Element {
  return (
    <div role="status" aria-label="Loading" className="flex h-full items-center justify-center p-6">
      <Loader2 className="text-muted-foreground h-5 w-5 motion-safe:animate-spin" />
    </div>
  )
}
