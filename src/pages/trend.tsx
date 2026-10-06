import { useEffect, useMemo, useState } from 'preact/hooks'
import type { AlignedData } from 'uplot'
import { UPlotChart, bucketKeyToX, trendXFormat } from '../ui/uplot-chart.tsx'
import { SegmentedControl } from '../ui/segmented-control.tsx'
import { RangeSelectorTabs, RangeSelectorPanelForBelow, useRangeSelectorState } from '../ui/range-selector.tsx'
import { KpiCard } from '../ui/kpi-card.tsx'
import { useQuery } from '../lib/use-query.ts'
import {
  QUERIES,
  rangeSignature,
  shapeTrend,
  shapeTrendByModel,
  aggregateCostByBucket,
  bucketAxis,
  trendGran,
  type BucketAxis,
  type TrendGran,
  type ParamQuery,
  type Range,
} from '../db/queries.ts'
import type { OpenedDb } from '../db/client.ts'
import type { TrendRow, TrendByModelRow } from '../db/types.ts'
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

const GRAN_ITEMS = [
  { id: 'hour', label: '小时' },
  { id: 'day', label: '日' },
  { id: 'week', label: '周' },
  { id: 'month', label: '月' },
] as const
type Gran = TrendGran

/** 细粒度选项：跨度 ≤7 天的范围提供（与速度页同一规则） */
const SECOND_GRAN_ITEM = { id: 'second', label: '30秒' } as const
const MINUTE_GRAN_ITEM = { id: 'minute', label: '5分钟' } as const
const FINE_GRAN_ITEMS = [SECOND_GRAN_ITEM, MINUTE_GRAN_ITEM, ...GRAN_ITEMS]

/** 各粒度的中文文案：short 用于「日成本/周均成本」类标签，unit 用于 KPI 副文案计数，max 为峰值卡标题 */
const GRAN_TEXT: Record<Gran, { short: string; unit: string; max: string }> = {
  second: { short: '每 30 秒', unit: '个 30 秒桶', max: '单桶最高成本' },
  minute: { short: '每 5 分钟', unit: '个 5 分钟桶', max: '单桶最高成本' },
  hour: { short: '每小时', unit: '个小时', max: '单桶最高成本' },
  day: { short: '日', unit: '天', max: '最高单日成本' },
  week: { short: '周', unit: '周', max: '最高单周成本' },
  month: { short: '月', unit: '个月', max: '最高单月成本' },
}

const modelPaths = splinePaths()

export function TrendPage({ db }: { db: OpenedDb }) {
  const { range, setPreset, setCustom } = useRange()
  const rs = useRangeSelectorState({ value: range, onPreset: setPreset, onCustom: setCustom })
  const [metric, setMetric] = useState<Metric>('token')
  const [dim, setDim] = useState<Dim>('total')
  const [topN, setTopN] = useState<TopN>('8')
  const [gran, setGran] = useState<Gran>('day')
  const marks = useMarks()
  const custom = useCustomModels()

  // 跨度 ≤7 天的范围（近30分钟/近7天/自定义短范围）提供 30秒/5分钟 细粒度选项；
  // 近30天/全部数据量过大，不提供（与速度页同一规则）
  const fineAllowed =
    range.kind === 'custom'
      ? range.to - range.from <= 7 * 86400 * 1000
      : range.preset === '30m' || range.preset === '7d'
  const granItems = fineAllowed ? FINE_GRAN_ITEMS : GRAN_ITEMS
  // 范围的自然粒度：短范围默认细粒度、长范围默认日桶
  const naturalGran = trendGran(range)
  // 范围变化（或细粒度可选集翻转）时把粒度重置为自然粒度；此后用户可手动切换
  useEffect(() => {
    setGran(naturalGran)
  }, [naturalGran, fineAllowed])

  // 所选粒度直接作为 granOverride 传给 SQL 分桶；
  // 桶内速度/TTFT 均值由 SQL 按原始 SUM 重算，粒度变化不影响口径
  const state = useQuery<{ rows: TrendRow[]; byModel: TrendByModelRow[]; totalCost: number; bucketCount: number }>(
    db,
    `trend:${rangeSignature(range)}:${gran}:${marksSignature(marks, custom)}`,
    async (d) => {
      const dayQ: ParamQuery = QUERIES.trend(range, [], gran)
      const dbyM: ParamQuery = QUERIES.trendByModel(range, gran)
      const [dayR, dbyMR] = await Promise.all([
        d.select(dayQ.sql, dayQ.bind),
        d.select(dbyM.sql, dbyM.bind),
      ])
      const byModel = shapeTrendByModel(dbyMR)
      const costMap = aggregateCostByBucket(byModel)
      const rows = shapeTrend(dayR, costMap)
      let totalCost = 0
      for (const r of rows) totalCost += r.cost
      return { rows, byModel, totalCost, bucketCount: rows.length }
    },
  )

  // 完整桶轴：SQL 只返回「有数据」的桶，直接拿结果里相邻两点连线，等于把中间几小时
  // 无数据的时间画成一条近似直线。铺满所选范围的桶后，空桶才能显式归零/断线。
  const axis = useMemo(
    () => (state.kind === 'ok' ? trendAxis(range, gran, state.data.rows) : EMPTY_AXIS),
    [state.kind === 'ok' ? state.data.rows : null, range, gran],
  )
  const rows = state.kind === 'ok' ? state.data.rows : null
  const byModel = state.kind === 'ok' ? state.data.byModel : null

  // 铺满轴后单个序列可达数万点，缓存住按交互维度计算的序列，避免无关渲染重算
  const modelSeries = useMemo(
    () => (byModel != null && dim === 'model' ? buildModelSeries(byModel, axis.keys, metric, topN, marks) : null),
    [byModel, axis, dim, metric, topN, marks],
  )
  const totalData = useMemo(
    () => (rows != null ? buildData(rows, metric, axis) : null),
    [rows, axis, metric],
  )

  // KPI 文案跟着所选粒度走
  const bucketCount = state.kind === 'ok' ? state.data.bucketCount : 0
  const granText = GRAN_TEXT[gran]
  const avgLabel =
    gran === 'day' || gran === 'week' || gran === 'month' ? `${granText.short}均成本` : `${granText.short}成本`
  const avgSub = `${bucketCount} ${granText.unit}`
  const maxLabel = granText.max

  return (
    <div class="page">
      <div class="section__header">
        <div>
          <h1 class="page__title">趋势</h1>
          <p class="page__subtitle">悬浮查看数值；图例可点击隐藏/显示单条线，悬停可聚焦该系列</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
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
          <SegmentedControl<Gran>
            value={gran}
            onChange={setGran}
            ariaLabel="时间粒度"
            items={granItems}
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
                label={avgLabel}
                tone="default"
                value={formatRMB(
                  state.data.bucketCount > 0 ? state.data.totalCost / state.data.bucketCount : 0,
                )}
                sub={avgSub}
              />
              <KpiCard
                label={maxLabel}
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
                data={axisData(axis, modelSeries.ys)}
                time
                height={300}
                seriesDefs={modelSeries.defs}
                yFormat={metricFormatter(metric)}
                xFormat={trendXFormat(range, gran)}
              />
            ) : totalData ? (
              <UPlotChart
                data={totalData}
                time
                height={280}
                seriesDefs={totalSeries(metric, gran)}
                yFormat={metricFormatter(metric)}
                xFormat={trendXFormat(range, gran)}
              />
            ) : null}
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

function costSeries(gran: Gran) {
  return [
    {
      label: `${GRAN_TEXT[gran].short}成本 (¥)`,
      stroke: '#1f6ec7',
      width: 2,
      fill: 'rgba(47, 135, 226, 0.10)',
      value: (_u: unknown, _raw: unknown, v: number | null) =>
        v == null ? '—' : formatRMB(v),
    },
  ]
}

const speedSeries = [
  {
    label: '输出速度 (tok/s)',
    stroke: '#8e6cc7',
    width: 2,
    fill: 'rgba(142, 108, 199, 0.12)',
    // 无样本的桶是 null：断线，别让折线跨过空档连成近似值
    spanGaps: false,
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
    spanGaps: false,
    value: (_u: unknown, _raw: unknown, v: number | null) =>
      v == null || v === 0 ? '—' : formatDuration(v),
  },
]

function totalSeries(metric: Metric, gran: Gran) {
  if (metric === 'cost') return costSeries(gran)
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

const EMPTY_AXIS: BucketAxis = { keys: [], xs: [] }

/** 结果行自身的桶（稀疏轴）：铺轴失败时的兜底，等价于改动前的行为 */
function sparseAxis(rows: readonly TrendRow[]): BucketAxis {
  return {
    keys: rows.map((r) => r.day),
    xs: rows.map((r) => bucketKeyToX(r.day)),
  }
}

/** 与 SQL 分桶同粒度的完整桶轴：[范围起, 范围止] 内的每个桶都在，
 *  「全部」范围以数据首末桶为界（否则数据集越老、右侧零段越长）。
 *  范围与粒度组合异常（桶数超上限）时退回稀疏轴。 */
function trendAxis(range: Range, gran: Gran, rows: readonly TrendRow[]): BucketAxis {
  const now = Date.now()
  const DAY_MS = 86_400_000
  const from =
    range.kind === 'custom' ? range.from
    : range.preset === '30m' ? now - 30 * 60_000
    : range.preset === '7d' ? now - 7 * DAY_MS
    : range.preset === '30d' ? now - 30 * DAY_MS
    : null
  if (from != null) return bucketAxis(gran, from, now) ?? sparseAxis(rows)
  const first = rows[0]
  const last = rows[rows.length - 1]
  if (first == null || last == null) return EMPTY_AXIS
  return bucketAxis(gran, bucketKeyToX(first.day) * 1000, bucketKeyToX(last.day) * 1000) ?? sparseAxis(rows)
}

/** 把稀疏的查询行按桶 key 铺到完整桶轴上；空桶填 empty（token/成本 0、速度/TTFT null）。 */
function alignSeries(
  axis: BucketAxis,
  byKey: ReadonlyMap<string, TrendRow>,
  pick: (r: TrendRow) => number | null,
  empty: number | null,
): (number | null)[] {
  return axis.keys.map((k) => {
    const r = byKey.get(k)
    return r == null ? empty : pick(r)
  })
}

/** 完整桶轴的 x + 各序列 → uPlot 数据（x 直接用轴上的桶起点，不再由 key 反解） */
function axisData(axis: BucketAxis, ys: (number | null)[][]): AlignedData {
  return [axis.xs, ...ys]
}

function buildData(rows: TrendRow[], metric: Metric, axis: BucketAxis): AlignedData {
  const byKey = new Map(rows.map((r) => [r.day, r]))
  // 成本：没有调用的桶就是 ¥0
  if (metric === 'cost') return [axis.xs, alignSeries(axis, byKey, (r) => r.cost, 0)]
  // 无样本的桶保留 null（配合 spanGaps:false 断线），画成 0 会被读成"该桶速度/TTFT 为 0"
  if (metric === 'speed') return [axis.xs, alignSeries(axis, byKey, (r) => r.avgOutputSpeed, null)]
  if (metric === 'ttft') return [axis.xs, alignSeries(axis, byKey, (r) => r.avgTtftMs, null)]
  // token 三线：没有调用的桶就是 0 token，显式归零
  return [
    axis.xs,
    alignSeries(axis, byKey, (r) => r.totalTokens, 0),
    alignSeries(axis, byKey, (r) => r.cacheReadTokens, 0),
    alignSeries(axis, byKey, (r) => r.outputTokens, 0),
  ]
}

// ---- 按模型分线 ----

type ModelSeries = {
  ys: (number | null)[][]
  defs: {
    label: string
    stroke: string
    width: number
    paths: unknown
    /** 速度/TTFT 的空桶是 null：断线，不跨空档连线 */
    spanGaps: boolean
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
  /** 桶内 token 总量（含 reasoning，与 computed_total_tokens 同口径） */
  tokens: number
  /** 桶内成本 ¥（按底层 model_id 各自计价后累加） */
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
 * 把「桶 × model_id」行按模型组展开成多条 y 序列。
 * 组 key 走 resolveGroupKey（尊重标记/改名），按区间总量降序取 Top N，
 * 未入选的模型合并为「其他」；缺数据的桶：token/成本为 0，速度/TTFT 为 null（断线）。
 */
function buildModelSeries(
  rows: readonly TrendByModelRow[],
  /** 完整桶轴上的桶 key（与轴的 x 同序），按 key 定位每行落在哪个点 */
  keys: readonly string[],
  metric: Metric,
  topN: TopN,
  marks: MarkMap,
): ModelSeries {
  const dayIdx = new Map<string, number>(keys.map((k, i) => [k, i]))
  // 组 key → 每日 bucket 序列（长度 = 天数）与区间总量
  const seriesMap = new Map<string, { ys: TimingBucket[]; total: number; tokenTotal: number }>()
  for (const r of rows) {
    const key = resolveGroupKey(r.modelId, 'name', marks)
    let entry = seriesMap.get(key)
    if (!entry) {
      entry = { ys: Array.from({ length: keys.length }, emptyTimingBucket), total: 0, tokenTotal: 0 }
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
    // inputTokens 已含 cacheReadTokens，不再叠加，避免缓存读重复计数
    const tokens = r.inputTokens + r.outputTokens + r.reasoningTokens + r.cacheCreationTokens
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
      spanGaps: false,
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
    // 先累加原始聚合量再算值：速度必须加权（Σ输出/Σ解码时长），不能把各组 tok/s 直接相加
    const merged = Array.from({ length: keys.length }, emptyTimingBucket)
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
      spanGaps: false,
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
  return { ys, defs }
}
