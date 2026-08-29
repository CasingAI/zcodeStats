import { useState } from 'preact/hooks'
import { UPlotChart, toTimeAlignedData } from '../ui/uplot-chart.tsx'
import { SegmentedControl } from '../ui/segmented-control.tsx'
import { RangeSelectorTabs, RangeSelectorPanelForBelow, useRangeSelectorState } from '../ui/range-selector.tsx'
import { KpiCard } from '../ui/kpi-card.tsx'
import { useQuery } from '../lib/use-query.ts'
import {
  QUERIES,
  rangeSignature,
  shapeByDay,
  shapeByDayByModel,
  aggregateCostByDay,
  type ParamQuery,
} from '../db/queries.ts'
import type { OpenedDb } from '../db/client.ts'
import type { ByDayRow } from '../db/types.ts'
import { useMarks, useCustomModels, marksSignature } from '../lib/model-groups.ts'
import { useRange } from '../lib/range-context.tsx'
import { formatCount, formatRMB } from '../lib/format.ts'

type Metric = 'token' | 'cost'

export function ByDayPage({ db }: { db: OpenedDb }) {
  const { range, setPreset, setCustom } = useRange()
  const rs = useRangeSelectorState({ value: range, onPreset: setPreset, onCustom: setCustom })
  const [metric, setMetric] = useState<Metric>('token')
  const marks = useMarks()
  const custom = useCustomModels()

  const state = useQuery<{ rows: ByDayRow[]; totalCost: number; activeDays: number }>(
    db,
    `by-day:${rangeSignature(range)}:${marksSignature(marks, custom)}`,
    async (d) => {
      const dayQ: ParamQuery = QUERIES.byDay(range)
      const dbyM: ParamQuery = QUERIES.byDayByModel(range)
      const [dayR, dbyMR] = await Promise.all([
        d.select(dayQ.sql, dayQ.bind),
        d.select(dbyM.sql, dbyM.bind),
      ])
      const costMap = aggregateCostByDay(shapeByDayByModel(dbyMR))
      const rows = shapeByDay(dayR, costMap)
      let totalCost = 0
      for (const r of rows) totalCost += r.cost
      return { rows, totalCost, activeDays: rows.length }
    },
  )

  return (
    <div class="page">
      <div class="section__header">
        <div>
          <h1 class="page__title">按日趋势</h1>
          <p class="page__subtitle">悬浮查看数值，拖拽框选缩放，双击复位</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <SegmentedControl<Metric>
            value={metric}
            onChange={setMetric}
            ariaLabel="指标"
            items={[
              { id: 'token', label: 'Token' },
              { id: 'cost', label: '成本' },
            ]}
          />
          <RangeSelectorTabs state={rs} ariaLabel="时间范围" />
        </div>
      </div>

      <RangeSelectorPanelForBelow state={rs} />

      <div class="section">
        {state.kind === 'loading' && <div class="app-banner">加载中…</div>}
        {state.kind === 'error' && <div class="app-banner app-banner--error">{state.error}</div>}
        {state.kind === 'ok' && state.data.rows.length === 0 && (
          <div class="app-banner">所选时间窗内无数据</div>
        )}
        {state.kind === 'ok' && state.data.rows.length > 0 && (
          <>
            <div class="kpi-grid kpi-grid--3" style={{ marginBottom: 12 }}>
              <KpiCard
                label="区间总成本"
                tone="orange"
                value={formatRMB(state.data.totalCost)}
                sub="按内置价目表估算"
              />
              <KpiCard
                label="日均成本"
                tone="default"
                value={formatRMB(
                  state.data.activeDays > 0 ? state.data.totalCost / state.data.activeDays : 0,
                )}
                sub={`${state.data.activeDays} 天`}
              />
              <KpiCard
                label="最高单日成本"
                tone="default"
                value={formatRMB(
                  state.data.rows.reduce((m, r) => (r.cost > m ? r.cost : m), 0),
                )}
                sub="用于发现突发高消耗"
              />
            </div>
            <UPlotChart
              data={buildData(state.data.rows, metric)}
              time
              height={280}
              seriesDefs={metric === 'token' ? tokenSeries : costSeries}
              yFormat={metric === 'token'
                ? (v) => (Math.abs(v) >= 1000 ? formatCount(v) : String(Math.round(v)))
                : (v) => formatRMB(v)
              }
              xFormat={(v) => {
                const d = new Date(v * 1000)
                return `${d.getUTCFullYear() % 100}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`
              }}
            />
          </>
        )}
      </div>
    </div>
  )
}

const tokenSeries = [
  {
    label: '总 token',
    stroke: '#1f6ec7',
    width: 2,
    fill: 'rgba(47, 135, 226, 0.08)',
    value: (_u: unknown, _raw: unknown, v: number | null) =>
      v == null ? '—' : formatCount(v),
  },
  {
    label: '缓存读取',
    stroke: '#34c759',
    width: 1.5,
    value: (_u: unknown, _raw: unknown, v: number | null) =>
      v == null ? '—' : formatCount(v),
  },
  {
    label: '输出',
    stroke: '#e07a3a',
    width: 1.2,
    value: (_u: unknown, _raw: unknown, v: number | null) =>
      v == null ? '—' : formatCount(v),
  },
]

const costSeries = [
  {
    label: '日成本 (¥)',
    stroke: '#1f6ec7',
    width: 2,
    fill: 'rgba(47, 135, 226, 0.10)',
    value: (_u: unknown, _raw: unknown, v: number | null) =>
      v == null ? '—' : formatRMB(v),
  },
]

function buildData(rows: ByDayRow[], metric: Metric) {
  const days = rows.map((r) => r.day)
  if (metric === 'cost') return toTimeAlignedData(days, [rows.map((r) => r.cost)])
  return toTimeAlignedData(days, [
    rows.map((r) => r.totalTokens),
    rows.map((r) => r.cacheReadTokens),
    rows.map((r) => r.outputTokens),
  ])
}
