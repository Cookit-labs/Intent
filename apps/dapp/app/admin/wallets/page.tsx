'use client'

import { DonutChart, TrendChart } from '../../../components/admin/charts'
import { EmptyNote, Kpi, PageTitle, Panel, WithStats } from '../../../components/admin/parts'
import { formatCount, formatUsd, shortAddress } from '../../../components/admin/stats'

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export default function AdminWalletsPage(): JSX.Element {
  return (
    <>
      <PageTitle title="Wallets" hint="Who is using Intent and how much they trade." />
      <WithStats>
        {({ overview, series, wallets }) => {
          const returning = Math.max(overview.wallets - overview.newWallets, 0)
          return (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <Kpi label="Active wallets" value={formatCount(overview.wallets)} />
                <Kpi label="New wallets" value={formatCount(overview.newWallets)} />
                <Kpi label="Returning wallets" value={formatCount(returning)} />
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                <Panel title="New and returning">
                  {overview.wallets === 0 ? (
                    <EmptyNote>No wallets were active in this period.</EmptyNote>
                  ) : (
                    <DonutChart
                      data={[
                        { name: 'New', value: overview.newWallets },
                        { name: 'Returning', value: returning },
                      ]}
                      format={formatCount}
                      total={formatCount(overview.wallets)}
                      totalLabel="Wallets"
                    />
                  )}
                </Panel>
                <Panel title="Active wallets per day">
                  <TrendChart
                    label="Wallets"
                    data={series.map((p) => ({ day: p.day, value: p.wallets }))}
                    format={formatCount}
                  />
                </Panel>
              </div>

              <Panel title="Top wallets" hint="By dollar volume in this period.">
                {wallets.length === 0 ? (
                  <EmptyNote>No wallets have traded in this period.</EmptyNote>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="text-muted-foreground">
                        <tr>
                          <th className="py-2 pr-4 font-normal">Wallet</th>
                          <th className="py-2 pr-4 text-right font-normal">Transactions</th>
                          <th className="py-2 pr-4 text-right font-normal">Volume</th>
                          <th className="py-2 text-right font-normal">Last active</th>
                        </tr>
                      </thead>
                      <tbody className="divide-border divide-y">
                        {wallets.map((w) => (
                          <tr key={w.account}>
                            <td className="py-2.5 pr-4 font-mono" title={w.account}>
                              {shortAddress(w.account)}
                            </td>
                            <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                              {formatCount(w.transactions)}
                            </td>
                            <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                              {formatUsd(w.volumeUsd)}
                            </td>
                            <td className="text-muted-foreground py-2.5 text-right">
                              {day(w.lastSeen)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </>
          )
        }}
      </WithStats>
    </>
  )
}
