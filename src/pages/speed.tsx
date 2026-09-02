import { useMemo, useState } from 'preact/hooks'
import { UPlotChart } from '../ui/uplot-chart.tsx'
import type { AlignedData } from 'uplot'
import { SegmentedControl } from '../ui/segmented-control.tsx'
import { RangeSelectorTabs, RangeSelectorPanelForBelow, useRangeSelectorState } from '../ui/range-selector.tsx'
import { KpiCard } from '../ui/kpi-card.tsx'
import { useQuery } from '../lib/use-query.ts'
import { QUERIES, rangeSignature, shapeSpeedTrend, shapeSpeedTrendSamples } from '../db/queries.ts'
import type { OpenedDb } from '../db/client.ts'
import type { SpeedTrendRow, SpeedSampleRow } from '../db/types.ts'
import {
  useMarks,
  resolveGroupKey,
  MODEL_LINE_COLORS,
  type MarkMap,
} from '../lib/model-groups.ts'
import { useRange } from '../lib/range-context.tsx'
import { displayNameOf } from '../lib/pricing.ts'
import {
  formatDuration,
  formatFull,
  formatTokensPerSecond,
} from '../lib/format.ts'
import { splinePaths } from '../lib/spline-paths.ts'

const GRAN_ITEMS = [
  { id: 'hour', label: '小时' },
  { id: 'day', label: '日' },
  { id: 'week', label: '周' },
] as const
type Gran = (typeof GRAN_ITEMS)[number]['id']

type TopN = '5' | '8' | 'all'

const STAT_ITEMS = [
  { id: 'avg', label: '平均' },
  { id: 'median', label: '中位数' },
  { id: 'max', label: '最大' },
  { id: 'min', label: '最小' },
] as const
type StatMode = (typeof STAT_ITEMS)[number]['id']

const modelPaths = splinePaths()

export function SpeedPage({ db }: { db: OpenedDb }) {
  const { range, setPreset, setCustom } = useRange()
  const rs = useRangeSelectorState({ value: range, onPreset: setPreset, onCustom: setCustom })
  const marks = useMarks()
  const [gran, setGran] = useState<Gran>('day')
  const [topN, setTopN] = useState<TopN>('8')
  const [statMode, setStatMode] = useState<StatMode>('avg')

  // marks 不影响 SQL 结果（速度与计价无关），只影响前端分组 → 不进 query key
  const state = useQuery<SpeedTrendRow[]>(
    db,
    `speed:${rangeSignature(range)}`,
    async (d) => {
      const q = QUERIES.speedTrend(range)
      return shapeSpeedTrend(await d.select(q.sql, q.bind))
    },
  )

  // 中位数明细：db 传 null 时 hook 保持 loading → 只在切到中位数口径时才真正查询
  const samples = useQuery<SpeedSampleRow[]>(
    statMode === 'median' ? db : null,
    `speed-samples:${rangeSignature(range)}`,
    async (d) => {
      const q = QUERIES.speedTrendSamples(range)
      return shapeSpeedTrendSamples(await d.select(q.sql, q.bind))
    },
  )

  const series = useMemo(() => {
    if (state.kind !== 'ok') return null
    if (statMode === 'median') {
      if (samples.kind !== 'ok') return null
      return buildMedianSeries(samples.data, gran, topN, marks)
    }
    return buildSpeedSeries(state.data, gran, topN, marks, statMode)
  }, [state.kind === 'ok' ? state.data : null, samples.kind === 'ok' ? samples.data : null, gran, topN, marks, statMode])

  const kpis = useMemo(() => {
    if (state.kind !== 'ok') return null
    return buildKpis(state.data, marks, statMode)
  }, [state.kind === 'ok' ? state.data : null, marks, statMode])

  // 中位数口径下的头条/最快模型（明细行算中位数）；TTFT 卡始终用主查询的 kpis
  const medianKpis = useMemo(() => {
    if (statMode !== 'median' || samples.kind !== 'ok') return null
    return buildMedianKpis(samples.data, marks)
  }, [statMode, samples.kind === 'ok' ? samples.data : null, marks])

  const headline = statMode === 'median' ? medianKpis?.headline ?? null : kpis?.headline ?? null
  const headlineLabel =
    statMode === 'median' ? '中位解码速度' :
    statMode === 'max' ? '单次最快速度' :
    statMode === 'min' ? '单次最慢速度' : '净解码速度'
  const headlineSub =
    statMode === 'median' ? (medianKpis?.headlineSub ?? '明细加载中…') : kpis?.headlineSub ?? ''
  const fastest = statMode === 'median' ? medianKpis?.fastest ?? null : kpis?.fastest ?? null

  const xFormat =
    gran === 'hour'
      ? (v: number) => {
          const d = new Date(v * 1000)
          const hh = String(d.getHours()).padStart(2, '0')
          // \n 让 uPlot 把日期/时间画成两行（原生支持，见 axis lineGap）
          return `${d.getMonth() + 1}/${d.getDate()}\n${hh}:00`
        }
      : (v: number) => {
          const d = new Date(v * 1000)
          return `${d.getFullYear() % 100}/${d.getMonth() + 1}/${d.getDate()}`
        }

  return (
    <div class="page">
      <div class="section__header">
        <div>
          <h1 class="page__title">输出速度</h1>
          <p class="page__subtitle">
            各模型解码速度趋势（同一张图，悬浮查看数值；图例可点击隐藏/显示单条线，悬停可聚焦该系列）。
            本页为<strong>净解码速度</strong>：仅统计主对话与子代理的正常生成请求（已剔除上下文压缩、标题生成等辅助请求），
            与总览等其他页面的平均速度口径不同。解码速度 = 输出 token ÷（总时长 − 首 token 等待），不含等首字的时间，无样本时段断线。
            统计口径：平均 = 按 token 加权；中位数 = 单次调用速度的中间值，最抗极值干扰；
            最大/最小 = 单次调用的极值，且仅统计解码窗口 ≥3s、输出 ≥32 token 的正常长度调用
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <SegmentedControl<StatMode>
            value={statMode}
            onChange={setStatMode}
            ariaLabel="统计口径"
            items={STAT_ITEMS}
          />
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
          <SegmentedControl<Gran>
            value={gran}
            onChange={setGran}
            ariaLabel="时间粒度"
            items={GRAN_ITEMS}
          />
          <RangeSelectorTabs state={rs} ariaLabel="时间范围" />
        </div>
      </div>

      <RangeSelectorPanelForBelow state={rs} />

      <div class="section">
        {state.kind === 'loading' && <div class="app-banner">加载中…</div>}
        {state.kind === 'error' && <div class="app-banner app-banner--error">{state.error}</div>}
        {state.kind === 'ok' && state.data.length === 0 && (
          <div class="app-banner">所选时间窗内没有可计算解码速度的调用（需要 completed、时长 &gt; 0、有输出且记录了有效首字时间）</div>
        )}
        {state.kind === 'ok' && statMode === 'median' && samples.kind === 'loading' && (
          <div class="app-banner">中位数明细加载中…</div>
        )}
        {state.kind === 'ok' && statMode === 'median' && samples.kind === 'error' && (
          <div class="app-banner app-banner--error">{samples.error}</div>
        )}
        {state.kind === 'ok' && state.data.length > 0 && kpis && (
          <>
            <div class="kpi-grid kpi-grid--3" style={{ marginBottom: 12 }}>
              <KpiCard
                label={headlineLabel}
                tone="orange"
                value={headline == null ? '—' : formatTokensPerSecond(headline)}
                sub={headlineSub}
              />
              <KpiCard
                label="平均首字等待"
                tone="blue"
                value={kpis.ttftAvg == null ? '—' : formatDuration(kpis.ttftAvg)}
                sub={
                  kpis.ttftSamples === 0
                    ? '当前数据未记录首字时间'
                    : `${formatFull(kpis.ttftSamples)} 次 TTFT 样本`
                }
              />
              <KpiCard
                label="最快模型"
                tone="default"
                value={fastest ? displayNameOf(fastest.key) : '—'}
                sub={
                  fastest
                    ? `${formatTokensPerSecond(fastest.speed)} · ${formatFull(fastest.n)} 次样本`
                    : '有效样本不足 10 次的模型不参与'
                }
              />
            </div>
            {series && (
              <UPlotChart
                className="uplot-legend-top"
                data={alignedData(series.keys, series.ys)}
                time
                height={340}
                seriesDefs={series.defs}
                yFormat={(v) => formatTokensPerSecond(v)}
                xFormat={xFormat}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** 折叠到目标粒度的桶 key：小时原样；日取前 10 位；周归到本地周一 */
function foldKey(bucket: string, gran: Gran): string {
  if (gran === 'hour') return bucket
  const day = bucket.slice(0, 10)
  if (gran === 'day') return day
  const d = new Date(`${day}T00:00:00`)
  const dow = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - dow)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 桶 key → x（unix 秒）。'YYYY-MM-DDTHH' 取该整点，'YYYY-MM-DD' 取本地午夜 */
function keyToX(key: string): number {
  const t = key.length > 10 ? `${key.slice(0, 10)}T${key.slice(11, 13)}:00:00` : `${key}T00:00:00`
  return Math.floor(Date.parse(t) / 1000)
}

function alignedData(keys: readonly string[], ys: readonly (readonly (number | null)[])[]): AlignedData {
  return [keys.map(keyToX), ...ys.map((arr) => Array.from(arr))]
}

type SpeedBucket = {
  speedOutputTokens: number
  speedDurationMs: number
  speedSampleCount: number
  speedMaxTokPerS: number | null
  speedMinTokPerS: number | null
}

/** 按统计口径取桶速度：平均 = token 加权；最大/最小 = 单次调用极值 */
function bucketSpeed(b: SpeedBucket, mode: StatMode): number | null {
  if (mode === 'max') return b.speedMaxTokPerS
  if (mode === 'min') return b.speedMinTokPerS
  return b.speedDurationMs > 0 ? (b.speedOutputTokens / b.speedDurationMs) * 1000 : null
}

/** 累加一段样本聚合到桶：加权字段直接累加，极值字段取极值（null 表示无有效样本） */
function mergeBucket(
  dst: SpeedBucket,
  outputTokens: number,
  durationMs: number,
  samples: number,
  maxTokPerS: number | null,
  minTokPerS: number | null,
): void {
  dst.speedOutputTokens += outputTokens
  dst.speedDurationMs += durationMs
  dst.speedSampleCount += samples
  if (maxTokPerS != null && (dst.speedMaxTokPerS == null || maxTokPerS > dst.speedMaxTokPerS)) {
    dst.speedMaxTokPerS = maxTokPerS
  }
  if (minTokPerS != null && (dst.speedMinTokPerS == null || minTokPerS < dst.speedMinTokPerS)) {
    dst.speedMinTokPerS = minTokPerS
  }
}

type SpeedSeries = {
  keys: string[]
  ys: (number | null)[][]
  defs: {
    label: string
    stroke: string
    width: number
    paths: unknown
    value: (_u: unknown, _raw: unknown, v: number | null) => string
  }[]
}

/**
 * 把「小时桶 × model_id」行折叠到所选粒度，按模型分线。
 * 组 key 走 resolveGroupKey（尊重标记/改名），按区间速度样本的 output_tokens 降序取 Top N；
 * 未入选模型合并为「其他」——平均先累加原始 out/dur 再算加权速度，最大/最小取极值。
 */
function buildSpeedSeries(
  rows: readonly SpeedTrendRow[],
  gran: Gran,
  topN: TopN,
  marks: MarkMap,
  statMode: StatMode,
): SpeedSeries {
  const keys: string[] = []
  const keySeen = new Set<string>()
  const groups = new Map<string, Map<string, SpeedBucket>>()
  const groupTotals = new Map<string, number>()
  for (const r of rows) {
    const gk = resolveGroupKey(r.modelId, 'name', marks)
    const bk = foldKey(r.bucket, gran)
    if (!keySeen.has(bk)) {
      keySeen.add(bk)
      keys.push(bk)
    }
    let gm = groups.get(gk)
    if (!gm) {
      gm = new Map()
      groups.set(gk, gm)
      groupTotals.set(gk, 0)
    }
    const b = gm.get(bk)
    if (b) {
      mergeBucket(b, r.speedOutputTokens, r.speedDurationMs, r.speedSampleCount, r.speedMaxTokPerS, r.speedMinTokPerS)
    } else {
      gm.set(bk, {
        speedOutputTokens: r.speedOutputTokens,
        speedDurationMs: r.speedDurationMs,
        speedSampleCount: r.speedSampleCount,
        speedMaxTokPerS: r.speedMaxTokPerS,
        speedMinTokPerS: r.speedMinTokPerS,
      })
    }
    groupTotals.set(gk, (groupTotals.get(gk) ?? 0) + r.speedOutputTokens)
  }

  const sorted = [...groups.keys()].sort(
    (a, b) => (groupTotals.get(b) ?? 0) - (groupTotals.get(a) ?? 0),
  )
  const limit = topN === 'all' ? sorted.length : Number(topN)
  const head = sorted.slice(0, limit)
  const tail = sorted.slice(limit)
  const colorOf = (i: number) => MODEL_LINE_COLORS[i % MODEL_LINE_COLORS.length] ?? '#1f6ec7'

  const defs: SpeedSeries['defs'] = []
  const ys: (number | null)[][] = []
  for (const gk of head) {
    const gm = groups.get(gk)!
    defs.push({
      label: displayNameOf(gk),
      stroke: colorOf(defs.length),
      width: 2,
      paths: modelPaths,
      value: (_u, _raw, v) => (v == null ? '—' : formatTokensPerSecond(v)),
    })
    ys.push(keys.map((k) => {
      const b = gm.get(k)
      return b ? bucketSpeed(b, statMode) : null
    }))
  }
  if (tail.length > 0) {
    const merged = new Map<string, SpeedBucket>()
    for (const gk of tail) {
      for (const [k, b] of groups.get(gk) ?? []) {
        const m = merged.get(k)
        if (m) {
          mergeBucket(m, b.speedOutputTokens, b.speedDurationMs, b.speedSampleCount, b.speedMaxTokPerS, b.speedMinTokPerS)
        } else {
          merged.set(k, { ...b })
        }
      }
    }
    defs.push({
      label: `其他（${tail.length} 个模型）`,
      stroke: colorOf(defs.length),
      width: 2,
      paths: modelPaths,
      value: (_u, _raw, v) => (v == null ? '—' : formatTokensPerSecond(v)),
    })
    ys.push(keys.map((k) => {
      const b = merged.get(k)
      return b ? bucketSpeed(b, statMode) : null
    }))
  }
  return { keys, ys, defs }
}

/** 中位数：偶数个样本取中间两行的算术平均（标准定义） */
function medianOf(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[mid] ?? null
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

type MedianKpis = {
  /** 全区间单次速度的中位数（tok/s） */
  headline: number | null
  headlineSub: string
  /** 样本 ≥ 10 次的组里中位数最高者 */
  fastest: { key: string; speed: number; n: number } | null
}

/**
 * 中位数口径分线：明细行（小时桶 × model_id × 单次速度）折叠到目标粒度后，
 * 每个（组 × 桶）取单次速度的中位数。TopN 按样本数降序（明细行没有 output_tokens 可加权）。
 */
function buildMedianSeries(
  rows: readonly SpeedSampleRow[],
  gran: Gran,
  topN: TopN,
  marks: MarkMap,
): SpeedSeries {
  const keys: string[] = []
  const keySeen = new Set<string>()
  const groups = new Map<string, Map<string, number[]>>()
  const groupCounts = new Map<string, number>()
  for (const r of rows) {
    const gk = resolveGroupKey(r.modelId, 'name', marks)
    const bk = foldKey(r.bucket, gran)
    if (!keySeen.has(bk)) {
      keySeen.add(bk)
      keys.push(bk)
    }
    let gm = groups.get(gk)
    if (!gm) {
      gm = new Map()
      groups.set(gk, gm)
      groupCounts.set(gk, 0)
    }
    const arr = gm.get(bk)
    if (arr) arr.push(r.speedTokPerS)
    else gm.set(bk, [r.speedTokPerS])
    groupCounts.set(gk, (groupCounts.get(gk) ?? 0) + 1)
  }

  const sorted = [...groups.keys()].sort(
    (a, b) => (groupCounts.get(b) ?? 0) - (groupCounts.get(a) ?? 0),
  )
  const limit = topN === 'all' ? sorted.length : Number(topN)
  const head = sorted.slice(0, limit)
  const tail = sorted.slice(limit)
  const colorOf = (i: number) => MODEL_LINE_COLORS[i % MODEL_LINE_COLORS.length] ?? '#1f6ec7'

  const defs: SpeedSeries['defs'] = []
  const ys: (number | null)[][] = []
  for (const gk of head) {
    const gm = groups.get(gk)!
    defs.push({
      label: displayNameOf(gk),
      stroke: colorOf(defs.length),
      width: 2,
      paths: modelPaths,
      value: (_u, _raw, v) => (v == null ? '—' : formatTokensPerSecond(v)),
    })
    ys.push(keys.map((k) => {
      const arr = gm.get(k)
      return arr ? medianOf(arr) : null
    }))
  }
  if (tail.length > 0) {
    const merged = new Map<string, number[]>()
    for (const gk of tail) {
      for (const [k, arr] of groups.get(gk) ?? []) {
        const m = merged.get(k)
        if (m) m.push(...arr)
        else merged.set(k, [...arr])
      }
    }
    defs.push({
      label: `其他（${tail.length} 个模型）`,
      stroke: colorOf(defs.length),
      width: 2,
      paths: modelPaths,
      value: (_u, _raw, v) => (v == null ? '—' : formatTokensPerSecond(v)),
    })
    ys.push(keys.map((k) => {
      const arr = merged.get(k)
      return arr ? medianOf(arr) : null
    }))
  }
  return { keys, ys, defs }
}

function buildMedianKpis(rows: readonly SpeedSampleRow[], marks: MarkMap): MedianKpis {
  const all: number[] = []
  const byGroup = new Map<string, number[]>()
  for (const r of rows) {
    all.push(r.speedTokPerS)
    const gk = resolveGroupKey(r.modelId, 'name', marks)
    const arr = byGroup.get(gk)
    if (arr) arr.push(r.speedTokPerS)
    else byGroup.set(gk, [r.speedTokPerS])
  }
  let fastest: MedianKpis['fastest'] = null
  for (const [key, arr] of byGroup) {
    if (arr.length < 10) continue
    const speed = medianOf(arr)
    if (speed != null && (fastest == null || speed > fastest.speed)) {
      fastest = { key, speed, n: arr.length }
    }
  }
  return {
    headline: medianOf(all),
    headlineSub: `${formatFull(all.length)} 次有效样本（中位数不受极值影响）`,
    fastest,
  }
}

type SpeedKpis = {
  /** 随统计口径变化的头条数值（tok/s）；无有效样本时为 null */
  headline: number | null
  /** 头条说明文字 */
  headlineSub: string
  /** 全区间平均首字等待（ms）；无 TTFT 样本时为 null */
  ttftAvg: number | null
  ttftSamples: number
  /** 样本 ≥ 10 次的组里按当前口径速度最高者 */
  fastest: { key: string; speed: number; n: number } | null
}

function buildKpis(rows: readonly SpeedTrendRow[], marks: MarkMap, statMode: StatMode): SpeedKpis {
  let outputTokens = 0
  let durationMs = 0
  let samples = 0
  let maxTokPerS: number | null = null
  let minTokPerS: number | null = null
  let ttftSumMs = 0
  let ttftSamples = 0
  const byGroup = new Map<string, SpeedBucket>()
  for (const r of rows) {
    outputTokens += r.speedOutputTokens
    durationMs += r.speedDurationMs
    samples += r.speedSampleCount
    if (r.speedMaxTokPerS != null && (maxTokPerS == null || r.speedMaxTokPerS > maxTokPerS)) {
      maxTokPerS = r.speedMaxTokPerS
    }
    if (r.speedMinTokPerS != null && (minTokPerS == null || r.speedMinTokPerS < minTokPerS)) {
      minTokPerS = r.speedMinTokPerS
    }
    ttftSumMs += r.ttftSumMs
    ttftSamples += r.ttftSampleCount
    const gk = resolveGroupKey(r.modelId, 'name', marks)
    const b = byGroup.get(gk)
    if (b) {
      mergeBucket(b, r.speedOutputTokens, r.speedDurationMs, r.speedSampleCount, r.speedMaxTokPerS, r.speedMinTokPerS)
    } else {
      byGroup.set(gk, {
        speedOutputTokens: r.speedOutputTokens,
        speedDurationMs: r.speedDurationMs,
        speedSampleCount: r.speedSampleCount,
        speedMaxTokPerS: r.speedMaxTokPerS,
        speedMinTokPerS: r.speedMinTokPerS,
      })
    }
  }
  let fastest: SpeedKpis['fastest'] = null
  for (const [key, b] of byGroup) {
    if (b.speedSampleCount < 10) continue
    const speed = bucketSpeed(b, statMode)
    if (speed != null && (fastest == null || speed > fastest.speed)) {
      fastest = { key, speed, n: b.speedSampleCount }
    }
  }
  const headline =
    statMode === 'max' ? maxTokPerS :
    statMode === 'min' ? minTokPerS :
    durationMs > 0 ? (outputTokens / durationMs) * 1000 : null
  const headlineSub =
    statMode === 'max' ? '区间内单次调用的最高速度（解码 ≥3s 且输出 ≥32 token）' :
    statMode === 'min' ? '区间内单次调用的最低速度（解码 ≥3s 且输出 ≥32 token）' :
    `${formatFull(samples)} 次有效样本`
  return {
    headline,
    headlineSub,
    ttftAvg: ttftSamples > 0 ? ttftSumMs / ttftSamples : null,
    ttftSamples,
    fastest,
  }
}
