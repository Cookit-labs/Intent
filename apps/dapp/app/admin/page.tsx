'use client'

import { DonutChart, OutcomeBars, RankedBars, TrendChart } from '../../components/admin/charts'
import { EmptyNote, Kpi, PageTitle, Panel, WithStats } from '../../components/admin/parts'
import { formatCount, formatPercent, formatUsd, kindLabel } from '../../components/admin/stats'

/** The types the headline volume adds up, so the donut and the total agree. */
const COUNTED = ['swap', 'plan', 'offer', 'send']

export default function AdminOverviewPage(): JSX.Element {
  return (
    <>
      <PageTitle
        title="Overview"
        hint="Everything people did on the chain and network chosen above, over the chosen dates."
      />
      <WithStats>
        {({ overview, series, kinds, pairs }) => {
          const valued = kinds.filter((k) => k.volumeUsd > 0 && COUNTED.includes(k.kind))
          return (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Kpi
                  label="Total volume"
                  value={formatUsd(overview.volumeUsd, true)}
                  note={
                    overview.unvalued > 0
                      ? `${formatCount(overview.unvalued)} transactions had no price`
                      : 'Swaps, limit and standing orders, sends'
                  }
                />
                <Kpi
                  label="Transactions"
                  value={formatCount(overview.transactions)}
                  note={
                    overview.successRate === null
                      ? 'Nothing submitted yet'
                      : `${formatPercent(overview.successRate)} accepted`
                  }
                />
                <Kpi
                  label="Intents recorded"
                  value={formatCount(overview.intents)}
                  note={`${formatCount(overview.reads.understood)} typed instructions understood`}
                />
                <Kpi
                  label="Active wallets"
                  value={formatCount(overview.wallets)}
                  note={`${formatCount(overview.newWallets)} new in this period`}
                />
              </div>

              <Panel title="Volume per day" hint="Dollar value of what people sold or sent.">
                <TrendChart
                  label="Volume"
                  data={series.map((p) => ({ day: p.day, value: p.volumeUsd }))}
                  format={(v) => formatUsd(v, true)}
                />
              </Panel>

              <div className="grid gap-6 lg:grid-cols-2">
                <Panel title="Volume by type" hint="Where the money went.">
                  {valued.length === 0 ? (
                    <EmptyNote>No priced transactions in this period.</EmptyNote>
                  ) : (
                    <DonutChart
                      data={valued.map((k) => ({ name: kindLabel(k.kind), value: k.volumeUsd }))}
                      format={(v) => formatUsd(v, true)}
                      total={formatUsd(
                        valued.reduce((a, k) => a + k.volumeUsd, 0),
                        true
                      )}
                      totalLabel="Total"
                    />
                  )}
                </Panel>

                <Panel title="Top pairs" hint="By dollar volume.">
                  {pairs.length === 0 ? (
                    <EmptyNote>No swaps in this period.</EmptyNote>
                  ) : (
                    <RankedBars
                      data={pairs.map((p) => ({
                        name: p.assetOut === null ? p.assetIn : `${p.assetIn} → ${p.assetOut}`,
                        value: p.volumeUsd,
                      }))}
                      format={(v) => formatUsd(v, true)}
                    />
                  )}
                </Panel>
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                <Panel title="Accepted and failed" hint="Transactions per day.">
                  <OutcomeBars
                    data={series.map((p) => ({
                      day: p.day,
                      ok: p.transactions,
                      failed: p.failed,
                    }))}
                  />
                </Panel>
                <Panel title="Active wallets per day">
                  <TrendChart
                    label="Wallets"
                    color="var(--series-3)"
                    data={series.map((p) => ({ day: p.day, value: p.wallets }))}
                    format={formatCount}
                  />
                </Panel>
              </div>
            </>
          )
        }}
      </WithStats>
    </>
  )
}
