'use client'

import { Fragment, useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

export const SERIES = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
] as const

const AXIS = { fontSize: 12, fill: 'hsl(var(--muted-foreground))' }

function shortDay(value: string): string {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
}

function TooltipCard({
  title,
  rows,
}: {
  title: string
  rows: { label: string; value: string; color?: string }[]
}): JSX.Element {
  return (
    <div className="border-border bg-background rounded-lg border px-3 py-2 text-sm shadow-lg">
      <p className="text-muted-foreground mb-1 text-xs">{title}</p>
      {rows.map((row) => (
        <p key={row.label} className="flex items-center gap-2">
          {row.color !== undefined ? (
            <span className="h-2 w-2 rounded-full" style={{ background: row.color }} />
          ) : null}
          <span className="text-muted-foreground">{row.label}</span>
          <span className="ml-auto pl-4 font-mono tabular-nums">{row.value}</span>
        </p>
      ))}
    </div>
  )
}

interface TrendProps {
  data: { day: string; value: number }[]
  /** Formats a value for the axis and the tooltip. */
  format: (value: number) => string
  label: string
  color?: string
  height?: number
}

/** One measure over days. A single series, so no legend: the card's title names it. */
export function TrendChart({
  data,
  format,
  label,
  color = SERIES[0],
  height = 240,
}: TrendProps): JSX.Element {
  const id = `trend-${label.replace(/\W+/g, '')}`
  return (
    <div role="img" aria-label={`${label} by day`} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="3 3" />
          <XAxis
            dataKey="day"
            tickFormatter={shortDay}
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            minTickGap={32}
          />
          <YAxis
            tickFormatter={format}
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            width={56}
            allowDecimals={false}
          />
          <Tooltip
            cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeDasharray: 3 }}
            content={({ active, payload }) => {
              const point = payload?.[0]?.payload as { day: string; value: number } | undefined
              if (!active || point === undefined) return null
              return (
                <TooltipCard
                  title={shortDay(point.day)}
                  rows={[{ label, value: format(point.value), color }]}
                />
              )
            }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            fill={`url(#${id})`}
            activeDot={{ r: 4, stroke: 'hsl(var(--background))', strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

export interface Slice {
  name: string
  value: number
}

/** Share of a total, with a legend that carries the numbers so colour is never the only key. */
export function DonutChart({
  data,
  format,
  total,
  totalLabel,
}: {
  data: Slice[]
  format: (value: number) => string
  total: string
  totalLabel: string
}): JSX.Element {
  const [hover, setHover] = useState<number | null>(null)
  const sum = data.reduce((acc, d) => acc + d.value, 0)

  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row">
      <div
        role="img"
        aria-label={`${totalLabel}: ${data.map((d) => `${d.name} ${format(d.value)}`).join(', ')}`}
        className="relative h-44 w-44 shrink-0"
      >
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius="68%"
              outerRadius="100%"
              paddingAngle={data.length > 1 ? 2 : 0}
              stroke="none"
              onMouseLeave={() => setHover(null)}
            >
              {data.map((d, i) => (
                <Cell
                  key={d.name}
                  fill={SERIES[i % SERIES.length]}
                  opacity={hover === null || hover === i ? 1 : 0.35}
                  onMouseEnter={() => setHover(i)}
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-display text-xl tabular-nums">
            {hover === null ? total : format(data[hover]?.value ?? 0)}
          </span>
          <span className="text-muted-foreground max-w-[6rem] truncate text-xs">
            {hover === null ? totalLabel : (data[hover]?.name ?? '')}
          </span>
        </div>
      </div>

      <ul className="flex w-full min-w-0 flex-1 flex-col gap-2">
        {data.map((d, i) => (
          <li
            key={d.name}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            className="flex items-center gap-2 text-sm"
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: SERIES[i % SERIES.length] }}
            />
            <span className="truncate">{d.name}</span>
            <span className="text-muted-foreground ml-auto font-mono text-xs tabular-nums">
              {sum === 0 ? '0%' : `${Math.round((d.value / sum) * 100)}%`}
            </span>
            <span className="w-20 text-right font-mono tabular-nums">{format(d.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Ranked horizontal bars, one series, labelled at the bar. */
export function RankedBars({
  data,
  format,
  height,
}: {
  data: Slice[]
  format: (value: number) => string
  height?: number
}): JSX.Element {
  const rowHeight = 36
  return (
    <div
      role="img"
      aria-label={data.map((d) => `${d.name} ${format(d.value)}`).join(', ')}
      style={{ height: height ?? Math.max(rowHeight * data.length, 72) }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 0, right: 72, bottom: 0, left: 0 }}
          barCategoryGap={10}
        >
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="name"
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            width={104}
          />
          <Tooltip
            cursor={{ fill: 'hsl(var(--muted) / 0.5)' }}
            content={({ active, payload }) => {
              const point = payload?.[0]?.payload as Slice | undefined
              if (!active || point === undefined) return null
              return (
                <TooltipCard
                  title={point.name}
                  rows={[{ label: 'Total', value: format(point.value), color: SERIES[0] }]}
                />
              )
            }}
          />
          <Bar
            dataKey="value"
            fill={SERIES[0]}
            radius={[0, 4, 4, 0]}
            label={{
              position: 'right',
              fontSize: 12,
              fill: 'hsl(var(--foreground))',
              formatter: (v: number) => format(v),
            }}
          >
            {data.map((d) => (
              <Cell key={d.name} fill={SERIES[0]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** A clustered pair per day: what worked next to what failed. */
export function OutcomeBars({
  data,
}: {
  data: { day: string; ok: number; failed: number }[]
}): JSX.Element {
  return (
    <Fragment>
      <div role="img" aria-label="Accepted and failed transactions by day" className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="3 3" />
            <XAxis
              dataKey="day"
              tickFormatter={shortDay}
              tick={AXIS}
              tickLine={false}
              axisLine={false}
              minTickGap={32}
            />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
            <Tooltip
              cursor={{ fill: 'hsl(var(--muted) / 0.5)' }}
              content={({ active, payload }) => {
                const point = payload?.[0]?.payload as
                  | { day: string; ok: number; failed: number }
                  | undefined
                if (!active || point === undefined) return null
                return (
                  <TooltipCard
                    title={shortDay(point.day)}
                    rows={[
                      { label: 'Accepted', value: String(point.ok), color: SERIES[0] },
                      { label: 'Failed', value: String(point.failed), color: SERIES[1] },
                    ]}
                  />
                )
              }}
            />
            <Bar dataKey="ok" stackId="a" fill={SERIES[0]} />
            <Bar dataKey="failed" stackId="a" fill={SERIES[1]} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex gap-4 text-sm">
        <span className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERIES[0] }} />
          Accepted
        </span>
        <span className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERIES[1] }} />
          Failed
        </span>
      </div>
    </Fragment>
  )
}
