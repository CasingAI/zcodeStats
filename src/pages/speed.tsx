import { useMemo, useState } from 'preact/hooks'
import { UPlotChart } from '../ui/uplot-chart.tsx'
import type { AlignedData } from 'uplot'
import { SegmentedControl } from '../ui/segmented-control.tsx'
import { RangeSelectorTabs, RangeSelectorPanelForBelow, useRangeSelectorState } from '../ui/range-selector.tsx'
import { KpiCard } from '../ui/kpi-card.tsx'
import { useQuery } from '../lib/use-query.ts'
import { QUERIES, rangeSignature, shapeSpeedTrend } from '../db/queries.ts'
import type { OpenedDb } from '../db/client.ts'
import type { SpeedTrendRow } from '../db/types.ts'
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

const modelPaths = splinePaths()

export function SpeedPage({ db }: { db: OpenedDb }) {
  const { range, setPreset, setCustom } = useRange()
  const rs = useRangeSelectorState({ value: range, onPreset: setPreset, onCustom: setCustom })
  const marks = useMarks()
  const [gran, setGran] = useState<Gran>('day')
  const [topN, setTopN] = useState<TopN>('8')

  // marks 不影响 SQL 结果（速度与计价无关），只影响前端分组 → 不进 query key
  const state = useQuery<SpeedTrendRow[]>(
    db,
    `speed:${rangeSignature(range)}`,
    async (d) => {
      const q = QUERIES.speedTrend(range)
      return shapeSpeedTrend(await d.select(q.sql, q.bind))
    },
  )

  const series = useMemo(() => {
    if (state.kind !== 'ok') return null
    return buildSpeedSeries(state.data, gran, topN, marks)
  }, [state.kind === 'ok' ? state.data : null, gran, topN, marks])

  const kpis = useMemo(() => {
    if (state.kind !== 'ok') return null
    return buildKpis(state.data, marks)
  }, [state.kind === 'ok' ? state.data : null, marks])

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
            解码速度 = 输出 token ÷（总时长 − 首 token 等待），按 token 加权，不含等首字的时间；
            仅统计记录了有效首字时间的调用，无样本时段断线
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
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
        {state.kind === 'ok' && state.data.length > 0 && kpis && (
          <>
            <div class="kpi-grid kpi-grid--3" style={{ marginBottom: 12 }}>
              <KpiCard
                label="区间解码速度"
                tone="orange"
                value={kpis.overall == null ? '—' : formatTokensPerSecond(kpis.overall)}
                sub={`${formatFull(kpis.samples)} 次有效样本`}
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
                value={kpis.fastest ? displayNameOf(kpis.fastest.key) : '—'}
                sub={
                  kpis.fastest
                    ? `${formatTokensPerSecond(kpis.fastest.speed)} · ${formatFull(kpis.fastest.n)} 次样本`
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
}

function bucketSpeed(b: SpeedBucket): number | null {
  return b.speedDurationMs > 0 ? (b.speedOutputTokens / b.speedDurationMs) * 1000 : null
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
 * 未入选模型合并为「其他」——先累加原始 out/dur 再算加权速度（不能直接加 tok/s）。
 */
function buildSpeedSeries(
  rows: readonly SpeedTrendRow[],
  gran: Gran,
  topN: TopN,
  marks: MarkMap,
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
      b.speedOutputTokens += r.speedOutputTokens
      b.speedDurationMs += r.speedDurationMs
      b.speedSampleCount += r.speedSampleCount
    } else {
      gm.set(bk, {
        speedOutputTokens: r.speedOutputTokens,
        speedDurationMs: r.speedDurationMs,
        speedSampleCount: r.speedSampleCount,
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
      return b ? bucketSpeed(b) : null
    }))
  }
  if (tail.length > 0) {
    const merged = new Map<string, SpeedBucket>()
    for (const gk of tail) {
      for (const [k, b] of groups.get(gk) ?? []) {
        const m = merged.get(k)
        if (m) {
          m.speedOutputTokens += b.speedOutputTokens
          m.speedDurationMs += b.speedDurationMs
          m.speedSampleCount += b.speedSampleCount
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
      return b ? bucketSpeed(b) : null
    }))
  }
  return { keys, ys, defs }
}

type SpeedKpis = {
  /** 区间整体加权解码速度（tok/s）；无有效样本时为 null */
  overall: number | null
  samples: number
  /** 全区间平均首字等待（ms）；无 TTFT 样本时为 null */
  ttftAvg: number | null
  ttftSamples: number
  /** 样本 ≥ 10 次的组里解码速度最高者 */
  fastest: { key: string; speed: number; n: number } | null
}

function buildKpis(rows: readonly SpeedTrendRow[], marks: MarkMap): SpeedKpis {
  let outputTokens = 0
  let durationMs = 0
  let samples = 0
  let ttftSumMs = 0
  let ttftSamples = 0
  const byGroup = new Map<string, SpeedBucket>()
  for (const r of rows) {
    outputTokens += r.speedOutputTokens
    durationMs += r.speedDurationMs
    samples += r.speedSampleCount
    ttftSumMs += r.ttftSumMs
    ttftSamples += r.ttftSampleCount
    const gk = resolveGroupKey(r.modelId, 'name', marks)
    const b = byGroup.get(gk)
    if (b) {
      b.speedOutputTokens += r.speedOutputTokens
      b.speedDurationMs += r.speedDurationMs
      b.speedSampleCount += r.speedSampleCount
    } else {
      byGroup.set(gk, {
        speedOutputTokens: r.speedOutputTokens,
        speedDurationMs: r.speedDurationMs,
        speedSampleCount: r.speedSampleCount,
      })
    }
  }
  let fastest: SpeedKpis['fastest'] = null
  for (const [key, b] of byGroup) {
    if (b.speedSampleCount < 10) continue
    const speed = bucketSpeed(b)
    if (speed != null && (fastest == null || speed > fastest.speed)) {
      fastest = { key, speed, n: b.speedSampleCount }
    }
  }
  return {
    overall: durationMs > 0 ? (outputTokens / durationMs) * 1000 : null,
    samples,
    ttftAvg: ttftSamples > 0 ? ttftSumMs / ttftSamples : null,
    ttftSamples,
    fastest,
  }
}
