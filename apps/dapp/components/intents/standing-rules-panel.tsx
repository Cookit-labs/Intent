'use client'

import { Button, Card } from '@intent/ui'
import { Bell, Clock, ExternalLink, X } from 'lucide-react'

import { stellarTestnet } from '@intent/config'
import { describeTrigger, evaluateTrigger } from '../../lib/standing-intent'
import type { StoredRule } from '../../lib/standing-store'

/**
 * Standing rules, and which of them are waiting on you right now.
 *
 * Two things this has to communicate, and the second is the awkward one.
 *
 * A rule is a promise about the future, so the list has to say what each one
 * is waiting for in the user's own terms — "when XLM falls to $0.16", not
 * "armed". Someone returning a week later has to recognise what they set up.
 *
 * And a rule firing is not a trade. The server watches rules whether or not
 * this page is open, and when one fires it emails the user and lists it in
 * the inbox — but nothing has moved until they sign. So a fired rule with no
 * transaction behind it is shown as waiting for a signature, not as done,
 * and keeps its sign button until there is a hash to show.
 */

function statusLabel(rule: StoredRule): string {
  switch (rule.status) {
    case 'armed':
      return 'Watching'
    case 'fired':
      return rule.lastTxHash === undefined ? 'Fired' : 'Done'
    case 'cancelled':
      return 'Stopped'
    case 'expired':
      return 'Expired'
  }
}

export function StandingRulesPanel({
  rules,
  prices,
  onExecute,
  onCancel,
  onClose,
}: {
  rules: StoredRule[]
  prices: Record<string, number>
  /** Called when the user approves a rule that has come due. */
  onExecute: (rule: StoredRule) => void
  onCancel: (id: string) => void
  onClose: () => void
}): JSX.Element {
  const armed = rules.filter((r) => r.status === 'armed')

  return (
    <div className="bg-card absolute inset-0 z-20 flex flex-col">
      <div className="border-border flex shrink-0 items-center justify-between border-b px-4 py-3">
        <span className="text-sm font-semibold">Standing rules</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close rules"
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {rules.length === 0 ? (
          <p className="text-muted-foreground p-6 text-center text-sm">
            Rules like “buy $50 of XLM if it drops to $0.16” or “every week move 50 USDC into XLM”
            are kept here and checked against the market.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rules.map((rule) => {
              const verdict = evaluateTrigger(rule, prices)
              // Due here, or fired by the server and not yet signed. Both are
              // the same thing to the user: a trade waiting for their approval.
              const isDue =
                (rule.status === 'armed' && verdict.fires) ||
                (rule.status === 'fired' && rule.lastTxHash === undefined)

              return (
                <li key={rule.id}>
                  <Card className="flex flex-col gap-2 p-3">
                    <div className="flex items-baseline justify-between gap-3">
                      {/* The rule as the user would say it, not as it is stored. */}
                      <span className="text-sm">{describeTrigger(rule)}</span>
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {statusLabel(rule)}
                      </span>
                    </div>

                    {/* Why it has not fired yet. "Watching" alone leaves a user
                        unable to tell a rule that is close from one that is far
                        away, or one whose price feed has failed. */}
                    {rule.status === 'armed' && !isDue && verdict.reason !== undefined ? (
                      <p className="text-muted-foreground text-xs">{verdict.reason}</p>
                    ) : null}

                    {rule.lastTxHash !== undefined ? (
                      <a
                        href={`${stellarTestnet.blockExplorerUrl}/tx/${rule.lastTxHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 self-start text-xs underline underline-offset-2"
                      >
                        View last trade
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : null}

                    <div className="flex items-center gap-2">
                      {isDue ? (
                        <Button size="sm" onClick={() => onExecute(rule)}>
                          <Bell className="mr-1.5 h-3.5 w-3.5" />
                          Ready — review and sign
                        </Button>
                      ) : null}
                      {rule.status === 'armed' ? (
                        <Button variant="ghost" size="sm" onClick={() => onCancel(rule.id)}>
                          Stop
                        </Button>
                      ) : null}
                    </div>
                  </Card>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* What "watching" means, stated where it cannot be missed. The rule is
          checked without the user; the trade still needs them. */}
      {armed.length > 0 ? (
        <div className="border-border text-muted-foreground shrink-0 border-t px-4 py-3 text-xs">
          <span className="inline-flex items-start gap-1.5">
            <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Rules are checked every minute, whether or not this page is open. When one fires you
              get an email and it appears in your inbox here — and it still asks for your signature
              before it trades.
            </span>
          </span>
        </div>
      ) : null}
    </div>
  )
}
