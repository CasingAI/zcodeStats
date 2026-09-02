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
                yFormat={metricFormatter(metric)}
                xFormat={(v) => {
                  const d = new Date(v * 1000)
                  return `${d.getFullYear() % 100}/${d.getMonth() + 1}/${d.getDate()}`
                }}
              />
            ) : (
              <UPlotChart
                data={buildData(state.data.rows, metric)}
                time
                height={280}
                seriesDefs={totalSeries(metric)}
                yFormat={metricFormatter(metric)}
                xFormat={(v) => {
                  const d = new Date(v * 1000)
                  return `${d.getFullYear() % 100}/${d.getMonth() + 1}/${d.getDate()}`
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

const speedSeries = [
  {
    label: '输出速度 (tok/s)',
    stroke: '#8e6cc7',
    width: 2,
    fill: 'rgba(142, 108, 199, 0.12)',
    value: (_u: unknown, _raw: unknown, v: number | null) =>
      v == null || v === 0 ? '—' : formatTokensPerSecond(v),
  },
]

const ttftSeries = [
  {
    label: 'TTFT (ms)',
    stroke: '#34c759',
    width: 2,
    fill: 'rgba(52, 199, 89, 0.12)',
    value: (_u: unknown, _raw: unknown, v: number | null) =>
      v == null || v === 0 ? '—' : formatDuration(v),
  },
]

function totalSeries(metric: Metric) {
  if (metric === 'cost') return costSeries
  if (metric === 'speed') return speedSeries
  if (metric === 'ttft') return ttftSeries
  return tokenSeries
}

function metricFormatter(metric: Metric) {
  if (metric === 'cost') return (v: number) => formatRMB(v)
  if (metric === 'speed') return (v: number) => formatTokensPerSecond(v)
  if (metric === 'ttft') return (v: number) => formatDuration(v)
  return (v: number) => (Math.abs(v) >= 1000 ? formatCount(v) : String(Math.round(v)))
}

function buildData(rows: ByDayRow[], metric: Metric) {
  const days = rows.map((r) => r.day)
  if (metric === 'cost') return toTimeAlignedData(days, [rows.map((r) => r.cost)])
  // 无样本的天保留 null（uPlot 断线），避免画成 0 造成"当天速度/TTFT 为 0"的误读
  if (metric === 'speed') {
    return toTimeAlignedData(days, [rows.map((r) => r.avgOutputSpeed)])
  }
  if (metric === 'ttft') {
    return toTimeAlignedData(days, [rows.map((r) => r.avgTtftMs)])
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
  ys: (number | null)[][]
  defs: {
    label: string
    stroke: string
    width: number
    paths: unknown
    value: (_u: unknown, _raw: unknown, v: number | null) => string
  }[]
}

type TimingBucket = {
  speedOutputTokens: number
  speedDurationMs: number
  speedSampleCount: number
  ttftSumMs: number
  ttftSampleCount: number
  totalDurationMs: number
  durationSampleCount: number
  /** 当日 token 总量（含 reasoning，与 computed_total_tokens 同口径） */
  tokens: number
  /** 当日成本 ¥（按底层 model_id 各自计价后累加） */
  cost: number
}

function emptyTimingBucket(): TimingBucket {
  return {
    speedOutputTokens: 0,
    speedDurationMs: 0,
    speedSampleCount: 0,
    ttftSumMs: 0,
    ttftSampleCount: 0,
    totalDurationMs: 0,
    durationSampleCount: 0,
    tokens: 0,
    cost: 0,
  }
}

function bucketValue(metric: Metric, b: TimingBucket): number | null {
  if (metric === 'speed') return b.speedDurationMs > 0 ? (b.speedOutputTokens / b.speedDurationMs) * 1000 : null
  if (metric === 'ttft') return b.ttftSampleCount > 0 ? b.ttftSumMs / b.ttftSampleCount : null
  if (metric === 'cost') return b.cost
  return b.tokens
}

/**
 * 把「日 × model_id」行按模型组展开成多条 y 序列。
 * 组 key 走 resolveGroupKey（尊重标记/改名），按区间总量降序取 Top N，
 * 未入选的模型合并为「其他」；缺数据的天：token/成本为 0，速度/TTFT 为 null（断线）。
 */
function buildModelSeries(
  rows: readonly ByDayByModelRow[],
  days: readonly string[],
  metric: Metric,
  topN: TopN,
  marks: MarkMap,
): ModelSeries {
  const dayIdx = new Map<string, number>(days.map((d, i) => [d, i]))
  // 组 key → 每日 bucket 序列（长度 = 天数）与区间总量
  const seriesMap = new Map<string, { ys: TimingBucket[]; total: number; tokenTotal: number }>()
  for (const r of rows) {
    const key = resolveGroupKey(r.modelId, 'name', marks)
    let entry = seriesMap.get(key)
    if (!entry) {
      entry = { ys: Array.from({ length: days.length }, emptyTimingBucket), total: 0, tokenTotal: 0 }
      seriesMap.set(key, entry)
    }
    const di = dayIdx.get(r.day)
    if (di == null) continue
    const bucket = entry.ys[di] ?? emptyTimingBucket()
    bucket.speedOutputTokens += r.speedOutputTokens
    bucket.speedDurationMs += r.speedDurationMs
    bucket.speedSampleCount += r.speedSampleCount
    bucket.ttftSumMs += r.ttftSumMs
    bucket.ttftSampleCount += r.ttftSampleCount
    bucket.totalDurationMs += r.totalDurationMs
    const tokens =
      r.inputTokens + r.outputTokens + r.reasoningTokens + r.cacheReadTokens + r.cacheCreationTokens
    bucket.tokens += tokens
    const cost = costFor(r.modelId, {
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      reasoningTokens: r.reasoningTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
    })
    bucket.cost += cost
    entry.ys[di] = bucket
    entry.tokenTotal += tokens
    if (metric === 'token') entry.total += tokens
    else if (metric === 'cost') entry.total += cost
  }

  // 排序：speed/ttft 按 token 总量降序（没有 token 时按对应 metric 总值）
  const sorted = [...seriesMap.entries()].sort((a, b) => {
    if (metric === 'speed' || metric === 'ttft') return b[1].tokenTotal - a[1].tokenTotal
    return b[1].total - a[1].total
  })
  const limit = topN === 'all' ? sorted.length : Number(topN)
  const head = sorted.slice(0, limit)
  const tail = sorted.slice(limit)
  const colorOf = (i: number) => MODEL_LINE_COLORS[i % MODEL_LINE_COLORS.length] ?? '#1f6ec7'

  const defs: ModelSeries['defs'] = []
  const ys: (number | null)[][] = []
  for (const [key, entry] of head) {
    const i = defs.length
    defs.push({
      label: displayNameOf(key),
      stroke: colorOf(i),
      width: 2,
      paths: modelPaths,
      value: (_u, _raw, v) => {
        if (v == null) return '—'
        if (metric === 'token') return formatCount(v)
        if (metric === 'cost') return formatRMB(v)
        if (metric === 'speed') return formatTokensPerSecond(v)
        return formatDuration(v)
      },
    })
    ys.push(entry.ys.map((b) => bucketValue(metric, b)))
  }
  if (tail.length > 0) {
    // 先累加原始聚合量再算值：速度必须加权（Σout/Σdur），不能把各组 tok/s 直接相加
    const merged = Array.from({ length: days.length }, emptyTimingBucket)
    for (const [, entry] of tail) {
      for (let i = 0; i < merged.length; i++) {
        const b = entry.ys[i] ?? emptyTimingBucket()
        const m = merged[i]!
        m.speedOutputTokens += b.speedOutputTokens
        m.speedDurationMs += b.speedDurationMs
        m.speedSampleCount += b.speedSampleCount
        m.ttftSumMs += b.ttftSumMs
        m.ttftSampleCount += b.ttftSampleCount
        m.totalDurationMs += b.totalDurationMs
        m.durationSampleCount += b.durationSampleCount
        m.tokens += b.tokens
        m.cost += b.cost
      }
    }
    defs.push({
      label: `其他（${tail.length} 个模型）`,
      stroke: colorOf(defs.length),
      width: 2,
      paths: modelPaths,
      value: (_u, _raw, v) => {
        if (v == null) return '—'
        if (metric === 'token') return formatCount(v)
        if (metric === 'cost') return formatRMB(v)
        if (metric === 'speed') return formatTokensPerSecond(v)
        return formatDuration(v)
      },
    })
    ys.push(merged.map((b) => bucketValue(metric, b)))
  }
  return { days: [...days], ys, defs }
}
