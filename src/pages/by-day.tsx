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
import type { ByDayRow, ByDayByModelRow } from '../db/types.ts'
import {
  useMarks,
  useCustomModels,
  marksSignature,
  resolveGroupKey,
  MODEL_LINE_COLORS,
  type MarkMap,
} from '../lib/model-groups.ts'
import { useRange } from '../lib/range-context.tsx'
import { displayNameOf, costFor } from '../lib/pricing.ts'
import {
  formatCount,
  formatDuration,
  formatRMB,
  formatTokensPerSecond,
} from '../lib/format.ts'
import { splinePaths } from '../lib/spline-paths.ts'

type Metric = 'token' | 'cost' | 'speed' | 'ttft'
type Dim = 'total' | 'model'
type TopN = '5' | '8' | 'all'

const modelPaths = splinePaths()

export function ByDayPage({ db }: { db: OpenedDb }) {
  const { range, setPreset, setCustom } = useRange()
  const rs = useRangeSelectorState({ value: range, onPreset: setPreset, onCustom: setCustom })
  const [metric, setMetric] = useState<Metric>('token')
  const [dim, setDim] = useState<Dim>('total')
  const [topN, setTopN] = useState<TopN>('8')
  const marks = useMarks()
  const custom = useCustomModels()

  const state = useQuery<{ rows: ByDayRow[]; byModel: ByDayByModelRow[]; totalCost: number; activeDays: number }>(
    db,
    `by-day:${rangeSignature(range)}:${marksSignature(marks, custom)}`,
    async (d) => {
      const dayQ: ParamQuery = QUERIES.byDay(range)
      const dbyM: ParamQuery = QUERIES.byDayByModel(range)
      const [dayR, dbyMR] = await Promise.all([
        d.select(dayQ.sql, dayQ.bind),
        d.select(dbyM.sql, dbyM.bind),
      ])
      const byModel = shapeByDayByModel(dbyMR)
      const costMap = aggregateCostByDay(byModel)
      const rows = shapeByDay(dayR, costMap)
      let totalCost = 0
      for (const r of rows) totalCost += r.cost
      return { rows, byModel, totalCost, activeDays: rows.length }
    },
  )

  const modelSeries =
    state.kind === 'ok' && dim === 'model'
      ? buildModelSeries(state.data.byModel, state.data.rows.map((r) => r.day), metric, topN, marks)
      : null

  return (
    <div class="page">
      <div class="section__header">
        <div>
          <h1 class="page__title">按日趋势</h1>
          <p class="page__subtitle">悬浮查看数值；图例可点击隐藏/显示单条线</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <SegmentedControl<Dim>
            value={dim}
            onChange={setDim}
            ariaLabel="维度"
            items={[
              { id: 'total', label: '总量' },
              { id: 'model', label: '按模型' },
            ]}
          />
          {dim === 'model' && (
            <SegmentedControl<TopN>
              value={topN}
              onChange={setTopN}
              ariaLabel="模型数量"
              items={[
                { id: '5', label: '前 5' },
                { id: '8', label: '前 8' },
                { id: 'all', label: '全部' },
              ]}
            />
          )}
          <SegmentedControl<Metric>
            value={metric}
            onChange={setMetric}
            ariaLabel="指标"
            items={[
              { id: 'token', label: 'Token' },
              { id: 'cost', label: '成本' },
              { id: 'speed', label: '速度' },
              { id: 'ttft', label: 'TTFT' },
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
            {dim === 'model' && modelSeries ? (
              <UPlotChart
                className="uplot-legend-top"
                data={toTimeAlignedData(modelSeries.days, modelSeries.ys)}
                time
                height={300}
                seriesDefs={modelSeries.defs}
                yFormat={metric === 'token'
                  ? (v) => (Math.abs(v) >= 1000 ? formatCount(v) : String(Math.round(v)))
                  : (v) => formatRMB(v)
                }
                xFormat={(v) => {
                  const d = new Date(v * 1000)
                  return `${d.getUTCFullYear() % 100}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`
                }}
              />
            ) : (
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
            )}
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
  if (metric === 'speed') {
    return toTimeAlignedData(days, [
      rows.map((r) => (r.avgOutputSpeed != null ? r.avgOutputSpeed : 0)),
    ])
  }
  if (metric === 'ttft') {
    return toTimeAlignedData(days, [rows.map((r) => (r.avgTtftMs != null ? r.avgTtftMs : 0))])
  }
  return toTimeAlignedData(days, [
    rows.map((r) => r.totalTokens),
    rows.map((r) => r.cacheReadTokens),
    rows.map((r) => r.outputTokens),
  ])
}

// ---- 按模型分线 ----

type ModelSeries = {
  days: string[]
  ys: number[][]
  defs: {
    label: string
    stroke: string
    width: number
    paths: unknown
    value: (_u: unknown, _raw: unknown, v: number | null) => string
  }[]
}

/**
 * 把「日 × model_id」行按模型组展开成多条 y 序列。
 * 组 key 走 resolveGroupKey（尊重标记/改名），按区间总量降序取 Top N，
 * 未入选的模型合并为「其他」；日期轴与总量图共用，缺数据的天补 0。
 */
function buildModelSeries(
  rows: readonly ByDayByModelRow[],
  days: readonly string[],
  metric: Metric,
  topN: TopN,
  marks: MarkMap,
): ModelSeries {
  const dayIdx = new Map<string, number>(days.map((d, i) => [d, i]))
  // 组 key → y 序列（长度 = 天数）与区间总量
  const seriesMap = new Map<string, { ys: number[]; total: number }>()
  for (const r of rows) {
    const key = resolveGroupKey(r.modelId, 'name', marks)
    let entry = seriesMap.get(key)
    if (!entry) {
      entry = { ys: new Array(days.length).fill(0), total: 0 }
      seriesMap.set(key, entry)
    }
    const v =
      metric === 'token'
        ? r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens
        : costFor(r.modelId, {
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            reasoningTokens: r.reasoningTokens,
            cacheReadTokens: r.cacheReadTokens,
            cacheCreationTokens: r.cacheCreationTokens,
          })
    const di = dayIdx.get(r.day)
    if (di == null) continue
    entry.ys[di] = (entry.ys[di] ?? 0) + v
    entry.total += v
  }

  const sorted = [...seriesMap.entries()].sort((a, b) => b[1].total - a[1].total)
  const limit = topN === 'all' ? sorted.length : Number(topN)
  const head = sorted.slice(0, limit)
  const tail = sorted.slice(limit)
  const colorOf = (i: number) => MODEL_LINE_COLORS[i % MODEL_LINE_COLORS.length] ?? '#1f6ec7'

  const defs: ModelSeries['defs'] = []
  const ys: number[][] = []
  for (const [key, entry] of head) {
    const i = defs.length
    defs.push({
      label: displayNameOf(key),
      stroke: colorOf(i),
      width: 2,
      paths: modelPaths,
      value: (_u, _raw, v) => {
        if (v == null) return '—'
        return metric === 'token' ? formatCount(v) : formatRMB(v)
      },
    })
    ys.push(entry.ys)
  }
  if (tail.length > 0) {
    const merged = new Array<number>(days.length).fill(0)
    for (const [, entry] of tail) {
      for (let i = 0; i < merged.length; i++) merged[i] = (merged[i] ?? 0) + (entry.ys[i] ?? 0)
    }
    defs.push({
      label: `其他（${tail.length} 个模型）`,
      stroke: colorOf(defs.length),
      width: 2,
      paths: modelPaths,
      value: (_u, _raw, v) => {
        if (v == null) return '—'
        return metric === 'token' ? formatCount(v) : formatRMB(v)
      },
    })
    ys.push(merged)
  }
  return { days: [...days], ys, defs }
}
