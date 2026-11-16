'use client'

import { ChainTable, TypeMatrix, VenueTable, chainName } from '../../components/admin/by-chain'
import { DonutChart, OutcomeBars, RankedBars, TrendChart } from '../../components/admin/charts'
import { EmptyNote, Kpi, PageTitle, Panel, WithStats } from '../../components/admin/parts'
import { useScope } from '../../components/admin/scope'
import {
  formatCount,
  formatNgn,
  formatPercent,
  formatUsd,
  kindLabel,
} from '../../components/admin/stats'

/**
 * The types the headline volume adds up, so the donut and the total agree.
 * Mirrors HEADLINE_KINDS in admin-metrics.ts — out of sync once already,
 * when offramp was added there and not here: the total counted cash-outs,
 * the donut silently dropped them, and a period that was 97% cash-outs by
 * dollar value read as "100% Swaps".
 */
const COUNTED = ['swap', 'plan', 'offer', 'send', 'offramp', 'unknown']

export default function AdminOverviewPage(): JSX.Element {
  const { scope } = useScope()
  const everyChain = scope.chain === 'all'
  return (
    <>
      <PageTitle
        title="Overview"
        hint="Everything people did on the chain and network chosen above, over the chosen dates."
      />
      <WithStats>
        {({ overview, series, kinds, pairs, chains, types, venues, naira }) => {
          const ngnPaid = naira.reduce((t, n) => t + n.ngn, 0)
          const ngnOrders = naira.reduce((t, n) => t + n.orders, 0)
          const valued = kinds.filter((k) => k.volumeUsd > 0 && COUNTED.includes(k.kind))
          return (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <Kpi
                  label="Total volume"
                  value={formatUsd(overview.volumeUsd, true)}
                  note={
                    overview.unvalued > 0
                      ? `${formatCount(overview.unvalued)} transactions had no price`
                      : 'Swaps, limit and standing orders, sends, off-ramps'
                  }
                />
                <Kpi
                  label="Naira paid out"
                  value={formatNgn(ngnPaid, true)}
                  note={
                    ngnOrders === 0
                      ? 'No naira off-ramps paid in this period'
                      : `${formatCount(ngnOrders)} off-ramp${ngnOrders === 1 ? '' : 's'} paid to banks`
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

              {everyChain ? (
                <Panel
                  title="Every chain"
                  hint="Volume counts what people sold, sent or off-ramped. A type not recorded means the chain's receipt was missing, so its value may be missing too."
                >
                  {chains.length === 0 ? (
                    <EmptyNote>Nothing ran on any chain in this period.</EmptyNote>
                  ) : (
                    <ChainTable rows={chains} naira={naira} />
                  )}
                </Panel>
              ) : null}

              <Panel
                title={everyChain ? 'What ran on each chain' : 'What ran'}
                hint="Accepted transactions by type, with their value."
              >
                {types.length === 0 ? (
                  <EmptyNote>Nothing ran in this period.</EmptyNote>
                ) : (
                  <TypeMatrix rows={types} />
                )}
              </Panel>

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

                <Panel title="Top pairs" hint="By dollar volume, with the chain each ran on.">
                  {pairs.length === 0 ? (
                    <EmptyNote>No swaps in this period.</EmptyNote>
                  ) : (
                    <RankedBars
                      data={pairs.map((p) => ({
                        name: `${p.assetOut === null ? p.assetIn : `${p.assetIn} → ${p.assetOut}`} on ${chainName(p.chain)}`,
                        value: p.volumeUsd,
                      }))}
                      format={(v) => formatUsd(v, true)}
                    />
                  )}
                </Panel>
              </div>

              <Panel
                title="Apps used"
                hint="Where transactions went, on chains that record the app."
              >
                {venues.length === 0 ? (
                  <EmptyNote>No app was recorded in this period.</EmptyNote>
                ) : (
                  <VenueTable rows={venues} />
                )}
              </Panel>

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
