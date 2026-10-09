'use client'

import { DonutChart, RankedBars } from '../../../components/admin/charts'
import { EmptyNote, Kpi, PageTitle, Panel, WithStats } from '../../../components/admin/parts'
import { formatCount, formatPercent } from '../../../components/admin/stats'

const TYPE_LABELS: Record<string, string> = {
  swap: 'Swaps',
  limit: 'Limit orders',
  standing: 'Standing orders',
  send: 'Sends',
  lend: 'Lending',
  supply: 'Lending',
}

const label = (value: string): string =>
  TYPE_LABELS[value] ?? value.charAt(0).toUpperCase() + value.slice(1)

export default function AdminIntentsPage(): JSX.Element {
  return (
    <>
      <PageTitle
        title="Intents"
        hint="What people asked for, how well it was understood, and how the agents did."
      />
      <WithStats>
        {({ overview, intents, agents }) => {
          const reads = intents.reads.understood + intents.reads.unreadable
          return (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Kpi label="Intents recorded" value={formatCount(overview.intents)} />
                <Kpi
                  label="Instructions understood"
                  value={reads === 0 ? 'No data' : formatPercent(intents.reads.understood / reads)}
                  note={`${formatCount(reads)} typed instructions`}
                />
                <Kpi
                  label="Agents agreed"
                  value={formatPercent(agents.unanimousRate)}
                  note="Races where every agent picked the same route"
                />
                <Kpi
                  label="Median answer time"
                  value={agents.p50Ms === null ? 'No data' : `${(agents.p50Ms / 1000).toFixed(1)}s`}
                  note={
                    agents.p95Ms === null
                      ? undefined
                      : `95% within ${(agents.p95Ms / 1000).toFixed(1)}s`
                  }
                />
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                <Panel title="Intents by type">
                  {intents.byType.length === 0 ? (
                    <EmptyNote>No intents in this period.</EmptyNote>
                  ) : (
                    <DonutChart
                      data={intents.byType.map((t) => ({ name: label(t.type), value: t.count }))}
                      format={formatCount}
                      total={formatCount(overview.intents)}
                      totalLabel="Intents"
                    />
                  )}
                </Panel>

                <Panel title="Standing and limit rules" hint="By current state.">
                  {intents.rules.length === 0 ? (
                    <EmptyNote>Nobody has set a rule in this period.</EmptyNote>
                  ) : (
                    <RankedBars
                      data={intents.rules.map((r) => ({ name: label(r.status), value: r.count }))}
                      format={formatCount}
                    />
                  )}
                </Panel>
              </div>

              <Panel title="Agents" hint="How often each one answered and won.">
                {agents.agents.length === 0 ? (
                  <EmptyNote>No agent races in this period.</EmptyNote>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="text-muted-foreground">
                        <tr>
                          <th className="py-2 pr-4 font-normal">Agent</th>
                          <th className="py-2 pr-4 text-right font-normal">Races</th>
                          <th className="py-2 pr-4 text-right font-normal">Answered</th>
                          <th className="py-2 pr-4 text-right font-normal">Won</th>
                          <th className="py-2 text-right font-normal">Median time</th>
                        </tr>
                      </thead>
                      <tbody className="divide-border divide-y">
                        {agents.agents.map((a) => (
                          <tr key={a.agent}>
                            <td className="py-2.5 pr-4">
                              <span className="font-mono">{a.agent}</span>
                              {a.model !== null ? (
                                <span className="text-muted-foreground block text-xs">
                                  {a.model}
                                </span>
                              ) : null}
                            </td>
                            <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                              {formatCount(a.races)}
                            </td>
                            <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                              {formatPercent(a.races === 0 ? null : a.answered / a.races)}
                            </td>
                            <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                              {formatCount(a.wins)}
                            </td>
                            <td className="py-2.5 text-right font-mono tabular-nums">
                              {a.p50Ms === null ? '—' : `${(a.p50Ms / 1000).toFixed(1)}s`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>

              {agents.failures.length > 0 ? (
                <Panel title="Why agents failed to answer">
                  <RankedBars
                    data={agents.failures.map((f) => ({ name: f.reason, value: f.count }))}
                    format={formatCount}
                  />
                </Panel>
              ) : null}
            </>
          )
        }}
      </WithStats>
    </>
  )
}
