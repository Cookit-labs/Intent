'use client'

import { Button, Card, cn } from '@intent/ui'
import { Bell, X } from 'lucide-react'

import type { StandingRuleRecord } from '../../lib/api/standing-client'
import { describeTrigger } from '../../lib/standing-intent'

/**
 * Rules that fired while the user was away, waiting on a signature.
 *
 * Deliberately says what fired and at what price, and nothing about what
 * happened next — because nothing did. A firing is the condition being met;
 * the trade is the user's to sign, here, exactly as a due rule asks for a
 * signature when the page is open. An inbox that read like a receipt would
 * be the settled-rows-that-never-happened bug with better typography.
 *
 * `focusId` is the rule a fired-rule email linked to. It is highlighted when
 * it is here; when it is not — already signed, or seen on another visit —
 * the panel says where to look instead of showing an empty list.
 */

function firedLine(item: StandingRuleRecord): string {
  const when =
    item.firedAt === null
      ? ''
      : new Date(item.firedAt).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })

  const trigger = item.rule.trigger
  if (trigger.kind === 'schedule' || item.firedPrice === null) {
    return `Due ${when}`.trim()
  }
  return `${trigger.asset} was $${item.firedPrice} on ${when}`
}

export function StandingInboxPanel({
  items,
  focusId,
  onSign,
  onClose,
}: {
  items: StandingRuleRecord[]
  focusId?: string
  /** Enters the same review-and-sign flow a due rule uses. */
  onSign: (item: StandingRuleRecord) => void
  onClose: () => void
}): JSX.Element {
  const focusMissing = focusId !== undefined && !items.some((i) => i.id === focusId)

  return (
    <div className="bg-card absolute inset-0 z-20 flex flex-col">
      <div className="border-border flex shrink-0 items-center justify-between border-b px-4 py-3">
        <span className="text-sm font-semibold">Fired rules</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inbox"
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {focusMissing ? (
          <p className="text-muted-foreground mb-3 text-xs">
            That rule is not waiting here. It may already be signed, or you have seen it on an
            earlier visit — it is listed under Standing rules either way.
          </p>
        ) : null}

        {items.length === 0 ? (
          <p className="text-muted-foreground p-6 text-center text-sm">
            When a rule fires while you are away, it is emailed to you and listed here. Nothing
            trades until you sign it.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <li key={item.id}>
                <Card
                  className={cn(
                    'flex flex-col gap-2 p-3',
                    item.id === focusId ? 'ring-foreground/40 ring-1' : ''
                  )}
                >
                  {/* The rule as the user would say it, not as it is stored. */}
                  <span className="text-sm">{describeTrigger(item.rule)}</span>
                  <p className="text-muted-foreground text-xs">{firedLine(item)}</p>
                  <div>
                    <Button size="sm" onClick={() => onSign(item)}>
                      <Bell className="mr-1.5 h-3.5 w-3.5" />
                      Sign now
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-border text-muted-foreground shrink-0 border-t px-4 py-3 text-xs">
        A fired rule is a prompt, not a trade. Each one asks for your signature before anything
        moves.
      </div>
    </div>
  )
}
