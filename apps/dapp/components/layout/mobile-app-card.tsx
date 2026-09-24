import { Smartphone } from 'lucide-react'

/**
 * A word about the mobile app, at the foot of the sidebar.
 *
 * Says one thing and asks for nothing: the app is being built, and the
 * intents, wallet and agents a user has here are the ones they will have
 * there. No form, no button. A promise with a sign-up box reads as a pitch;
 * a promise alone reads as news, which is what this is.
 */
export function MobileAppCard({ className }: { className?: string }): JSX.Element {
  return (
    <div
      className={`border-border bg-card flex flex-col items-center gap-2 rounded-xl border px-4 py-5 text-center ${className ?? ''}`}
    >
      <span className="bg-brand/15 text-brand flex h-11 w-11 items-center justify-center rounded-full">
        <Smartphone className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
      </span>
      <p className="font-display text-sm font-semibold leading-tight">Intent on your phone</p>
      <p className="text-muted-foreground text-xs leading-relaxed">
        The mobile app is in the works. Same wallet, same agents, signed from anywhere.
      </p>
      <span className="border-border text-muted-foreground mt-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium">
        Coming soon
      </span>
    </div>
  )
}
