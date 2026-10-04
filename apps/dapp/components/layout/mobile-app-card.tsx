import { PhoneMockup } from './phone-mockup'

/**
 * A word about the mobile app, at the foot of the sidebar.
 *
 * Says one thing and asks for nothing: the app is being built, and the
 * intents, wallet and agents a user has here are the ones they will have
 * there. No form, no button. A promise with a sign-up box reads as a pitch;
 * a promise alone reads as news, which is what this is.
 *
 * The phone rises from the bottom edge and is cut off by it, so the card
 * stays short. On a screen too short to spare the height it is left out and
 * the words carry the card alone.
 */
export function MobileAppCard({ className }: { className?: string }): JSX.Element {
  return (
    <div
      className={`border-border bg-card relative flex flex-col items-center overflow-hidden rounded-xl border pt-5 text-center ${className ?? ''}`}
    >
      <div className="flex flex-col items-center gap-1.5 px-4">
        <p className="font-display text-sm font-semibold leading-tight">Intent on your phone</p>
        <p className="text-muted-foreground text-xs leading-relaxed">
          The mobile app is in the works. Same wallet, same agents, signed from anywhere.
        </p>
        <span className="border-border text-muted-foreground mt-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium">
          Coming soon
        </span>
      </div>

      <div className="mt-5 h-[196px] w-full overflow-hidden [@media(max-height:780px)]:hidden">
        <PhoneMockup />
      </div>
      <div className="pb-4 [@media(min-height:781px)]:hidden" />
    </div>
  )
}
