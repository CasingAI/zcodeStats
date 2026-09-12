import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { UPlotChart, bucketKeyToX } from '../ui/uplot-chart.tsx'
import type { AlignedData } from 'uplot'
import { SegmentedControl } from '../ui/segmented-control.tsx'
import { RangeSelectorTabs, RangeSelectorPanelForBelow, useRangeSelectorState } from '../ui/range-selector.tsx'
import { KpiCard } from '../ui/kpi-card.tsx'
import { DataTable } from '../ui/data-table.tsx'
import { useQuery } from '../lib/use-query.ts'
import { rangeSignature, type Range } from '../db/queries.ts'
import { ESTIMATE_CHARS_PER_TOKEN } from '../lib/glm-tokenizer.ts'
import type { OpenedDb } from '../db/client.ts'
import type { ThinkingProgress, ThinkingResult, ThinkingRow } from '../db/types.ts'
import {
  useMarks,
  resolveGroupKey,
  MODEL_LINE_COLORS,
  type MarkMap,
} from '../lib/model-groups.ts'
import { useRange } from '../lib/range-context.tsx'
import { displayNameOf, costFor } from '../lib/pricing.ts'
import { formatCount, formatDuration, formatFull, formatRMB } from '../lib/format.ts'
import { splinePaths } from '../lib/spline-paths.ts'

type Metric = 'token' | 'time'
type Dim = 'total' | 'model'
type TopN = '5' | '8' | 'all'
type Gran = 'hour' | 'day' | 'week' | 'month'

const GRAN_ITEMS = [
  { id: 'hour', label: '小时' },
  { id: 'day', label: '日' },
  { id: 'week', label: '周' },
  { id: 'month', label: '月' },
] as const

const modelPaths = splinePaths()

/** 把全局时间范围换算成毫秒区间 [from, to)。口径与 queries.ts 的 rangeClause 一致。 */
function rangeBounds(range: Range): { from: number; to: number } {
  if (range.kind === 'custom') return { from: range.from, to: range.to }
  if (range.preset === 'all') return { from: 0, to: Number.MAX_SAFE_INTEGER }
  const ms = range.preset === '30m' ? 30 * 60 * 1000 : (range.preset === '7d' ? 7 : 30) * 86400 * 1000
  return { from: Date.now() - ms, to: Number.MAX_SAFE_INTEGER }
}

/** 范围的自然展示粒度：短范围看小时，长范围看天 */
function naturalGran(range: Range): Gran {
  if (range.kind === 'custom') return range.to - range.from >= 48 * 3600 * 1000 ? 'day' : 'hour'
  return range.preset === '30m' ? 'hour' : 'day'
}

/** 小时桶折叠到目标粒度：周归并到本地周一，月取 'YYYY-MM'（同速度页 foldKey） */
function foldKey(bucket: string, gran: Gran): string {
  if (gran === 'hour') return bucket
  const day = bucket.slice(0, 10)
  if (gran === 'day') return day
  if (gran === 'month') return day.slice(0, 7)
  const d = new Date(`${day}T00:00:00`)
  const dow = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - dow)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 单行思考 token 值（双口径）：
 * - 精确阶段：接口报数 + GLM 分词器计数直接相加；
 * - 计数未完成：GLM 行按「字符 ÷ 标定字符数」估算（chars 只存在于 GLM 行），
 *   其余模型用报数。估算与部分计数不混用，避免重复计算。
 */
function rowTokenValue(r: ThinkingRow, exact: boolean): number {
  if (exact) return r.reportedTokens + r.countedTokens
  return r.chars > 0 ? Math.round(r.chars / ESTIMATE_CHARS_PER_TOKEN) : r.reportedTokens
}

export function ThinkingPage({ db }: { db: OpenedDb }) {
  const { range, setPreset, setCustom } = useRange()
  const rs = useRangeSelectorState({ value: range, onPreset: setPreset, onCustom: setCustom })
  const marks = useMarks()
  const [metric, setMetric] = useState<Metric>('token')
  const [dim, setDim] = useState<Dim>('total')
  const [topN, setTopN] = useState<TopN>('8')
  const [gran, setGran] = useState<Gran>('day')
  const [progress, setProgress] = useState<ThinkingProgress | null>(null)
  // 聚合快照（worker 先行下发）：让页面在 GLM 精确计数完成前就按估算渲染
  const [aggs, setAggs] = useState<ThinkingRow[] | null>(null)
  const abortRef = useRef<(() => void) | null>(null)

  // 范围变化时把粒度重置为自然粒度；此后用户可手动切换
  const natGran = naturalGran(range)
  useEffect(() => {
    setGran(natGran)
  }, [natGran])

  // marks 不影响 SQL 结果（前端分组才用），不进 query key。
  // SQL 固定小时桶，粒度切换纯前端折叠 → 一个范围只查一次。
  const state = useQuery<ThinkingResult>(
    db,
    `thinking:${rangeSignature(range)}`,
    async (d) => {
      setProgress(null)
      setAggs(null)
      const bounds = rangeBounds(range)
      const { result, abort } = d.thinking({ from: bounds.from, to: bounds.to }, (p) => {
        if (p.phase === 'aggregates') setAggs(p.rows)
        else setProgress(p)
      })
      abortRef.current = abort
      return result
    },
  )

  // 页面卸载时请求中止计数（后台批次边界停下，已算完的进入缓存不浪费）
  useEffect(
    () => () => {
      abortRef.current?.()
    },
    [],
  )

  // 最终结果优先；没回来之前用聚合快照（估算口径）渲染
  const rows = state.kind === 'ok' ? state.data.rows : aggs
  const exact = state.kind === 'ok' ? state.data.exact : false

  const series = useMemo(() => {
    if (rows == null) return null
    return buildSeries(rows, exact, gran, metric, dim, topN, marks)
  }, [rows, exact, gran, metric, dim, topN, marks])

  const kpis = useMemo(() => {
    if (rows == null) return null
    return buildKpis(rows, exact, marks)
  }, [rows, exact, marks])

  const xFormat = (v: number): string => {
    const d = new Date(v * 1000)
    const p = (n: number) => String(n).padStart(2, '0')
    if (gran === 'hour') return `${d.getMonth() + 1}/${d.getDate()}\n${p(d.getHours())}:00`
    if (gran === 'month') return `${d.getFullYear() % 100}/${d.getMonth() + 1}`
    return `${d.getFullYear() % 100}/${d.getMonth() + 1}/${d.getDate()}`
  }

  return (
    <div class="page">
      <div class="section__header">
        <div>
          <h1 class="page__title">思考</h1>
          <p class="page__subtitle">
            模型回答前的推理过程（思考片段来自会话记录，带起止时间）。Token 双口径：
            deepseek、kimi 等为<strong>接口报数</strong>；GLM 系接口未报思考量，由
            <strong>GLM 官方开源分词器</strong>对思考原文精确计数（首次需后台计算，之后走缓存，计数完成前显示按
            {' '}
            {ESTIMATE_CHARS_PER_TOKEN} 字符/token 的估算值）；其余未上报的模型只统计时长与次数。
            悬浮查看数值；图例可点击隐藏/显示单条线，悬停可聚焦该系列
          </p>
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
              { id: 'time', label: '时长' },
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
        {state.kind === 'loading' && progress == null && (
          <div class="app-banner">加载中…（正在打开会话记录）</div>
        )}
        {state.kind === 'loading' && progress?.phase === 'scan' && (
          <div class="app-banner">
            正在扫描会话记录中的思考片段…已找到 {formatFull(progress.found)} 段
          </div>
        )}
        {state.kind === 'loading' && progress?.phase === 'tokenizer' && (
          <div class="app-banner">正在加载 GLM 官方分词器…（首次约 20MB，之后走浏览器缓存）</div>
        )}
        {state.kind === 'error' && <div class="app-banner app-banner--error">{state.error}</div>}
        {state.kind === 'ok' && state.data.rows.length === 0 && (
          <div class="app-banner">所选时间窗内没有思考数据</div>
        )}
        {progress?.phase === 'count' && progress.counted < progress.total ? (
          state.kind === 'ok' ? (
            <div class="app-banner">GLM 精确计数已中断，Token 当前为估算值（重新进入本页会续算）</div>
          ) : (
            <div class="app-banner">
              GLM 思考精确计数中：{formatFull(progress.counted)} / {formatFull(progress.total)} 段…
              （下方数值为估算，完成后自动替换为精确值）
            </div>
          )
        ) : null}
        {rows != null && rows.length > 0 && kpis && (
          <>
            <div class="kpi-grid kpi-grid--3" style={{ marginBottom: 12 }}>
              <KpiCard
                label="思考 Token 总量"
                tone="orange"
                value={formatCount(kpis.tokens)}
                badge={exact ? undefined : '估算'}
                sub={exact ? kpis.tokenSubExact : kpis.tokenSubEstimate}
              />
              <KpiCard
                label="思考总时长"
                tone="blue"
                value={formatDuration(kpis.thinkMs)}
                sub={`${formatFull(kpis.parts)} 段思考 · 平均每次 ${
                  kpis.parts > 0 ? formatDuration(kpis.thinkMs / kpis.parts) : '—'
                }`}
              />
              <KpiCard
                label="思考成本估算"
                value={formatRMB(kpis.cost)}
                sub={`思考 token 按各模型输出价计 · ${exact ? '含分词器计数部分' : '含估算部分'}`}
              />
            </div>
            {series && (
              <UPlotChart
                className="uplot-legend-top"
                data={alignedData(series.keys, series.ys)}
                time
                height={340}
                seriesDefs={series.defs}
                yFormat={(v: number) =>
                  metric === 'token' ? formatCount(v) : formatDuration(v)
                }
                xFormat={xFormat}
              />
            )}
          </>
        )}
      </div>

      {rows != null && rows.length > 0 && kpis && kpis.byModel.length > 0 && (
        <div class="section" style={{ marginTop: 12 }}>
          <DataTable
            rows={kpis.byModel}
            rowKey={(r) => r.key}
            columns={[
              {
                key: 'model',
                header: '模型',
                render: (r) => displayNameOf(r.key),
                width: '220px',
              },
              {
                key: 'parts',
                header: '思考段数',
                align: 'right',
                render: (r) => formatFull(r.parts),
              },
              {
                key: 'thinkMs',
                header: '思考总时长',
                align: 'right',
                render: (r) => formatDuration(r.thinkMs),
              },
              {
                key: 'avg',
                header: '平均段时长',
                align: 'right',
                render: (r) => (r.parts > 0 ? formatDuration(r.thinkMs / r.parts) : '—'),
              },
              {
                key: 'tokens',
                header: exact ? '思考 Token' : '思考 Token（估）',
                align: 'right',
                render: (r) => (r.hasTokens ? formatCount(r.tokens) : '未上报'),
              },
              {
                key: 'cost',
                header: '成本估算',
                align: 'right',
                render: (r) => (r.hasTokens ? formatRMB(r.cost) : '—'),
              },
            ]}
          />
        </div>
      )}
    </div>
  )
}

function alignedData(keys: readonly string[], ys: readonly (readonly number[])[]): AlignedData {
  return [keys.map(bucketKeyToX), ...ys.map((arr) => Array.from(arr))]
}

// ---- 聚合 ----

type ThinkBucket = { v: number }

type ThinkSeries = {
  keys: string[]
  ys: number[][]
  defs: {
    label: string
    stroke: string
    width: number
    paths?: unknown
    fill?: string
    value: (_u: unknown, _raw: unknown, v: number | null) => string
  }[]
}

/**
 * 把「小时桶 × 模型」行折叠到目标粒度并按维度分线。
 * 组 key 走 resolveGroupKey（尊重标记/改名），按区间总量降序取 Top N，
 * 未入选模型合并为「其他」；缺数据的桶取 0（没有思考就是 0，不像速度需要断线）。
 */
function buildSeries(
  rows: readonly ThinkingRow[],
  exact: boolean,
  gran: Gran,
  metric: Metric,
  dim: Dim,
  topN: TopN,
  marks: MarkMap,
): ThinkSeries {
  const keys: string[] = []
  const keySeen = new Set<string>()
  const groups = new Map<string, Map<string, ThinkBucket>>()
  const totals = new Map<string, number>()
  for (const r of rows) {
    const gk = dim === 'total' ? '__total__' : resolveGroupKey(r.modelId, 'name', marks)
    const bk = foldKey(r.bucket, gran)
    if (!keySeen.has(bk)) {
      keySeen.add(bk)
      keys.push(bk)
    }
    let gm = groups.get(gk)
    if (!gm) {
      gm = new Map()
      groups.set(gk, gm)
      totals.set(gk, 0)
    }
    const v = metric === 'token' ? rowTokenValue(r, exact) : r.thinkMs
    const b = gm.get(bk)
    if (b) b.v += v
    else gm.set(bk, { v })
    totals.set(gk, (totals.get(gk) ?? 0) + v)
  }

  const sorted = [...groups.keys()].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0))
  const limit = dim === 'total' || topN === 'all' ? sorted.length : Number(topN)
  const head = sorted.slice(0, limit)
  const tail = sorted.slice(limit)
  const colorOf = (i: number) => MODEL_LINE_COLORS[i % MODEL_LINE_COLORS.length] ?? '#1f6ec7'
  const valueFmt =
    metric === 'token'
      ? (v: number | null) => (v == null ? '—' : formatCount(v))
      : (v: number | null) => (v == null ? '—' : formatDuration(v))

  const defs: ThinkSeries['defs'] = []
  const ys: number[][] = []
  for (const gk of head) {
    const gm = groups.get(gk)!
    const isTotal = dim === 'total'
    defs.push({
      label: isTotal ? (metric === 'token' ? '思考 Token' : '思考时长') : displayNameOf(gk),
      stroke: isTotal ? (metric === 'token' ? '#7a5cc0' : '#34c759') : colorOf(defs.length),
      width: 2,
      paths: isTotal ? undefined : modelPaths,
      fill: isTotal
        ? metric === 'token'
          ? 'rgba(122, 92, 192, 0.10)'
          : 'rgba(52, 199, 89, 0.10)'
        : undefined,
      value: (_u, _raw, v) => valueFmt(v),
    })
    ys.push(
      keys.map((k) => {
        const b = gm.get(k)
        return b ? b.v : 0
      }),
    )
  }
  if (tail.length > 0) {
    const merged = new Map<string, ThinkBucket>()
    for (const gk of tail) {
      for (const [k, b] of groups.get(gk) ?? []) {
        const m = merged.get(k)
        if (m) m.v += b.v
        else merged.set(k, { v: b.v })
      }
    }
    defs.push({
      label: `其他（${tail.length} 个模型）`,
      stroke: colorOf(defs.length),
      width: 2,
      paths: modelPaths,
      value: (_u, _raw, v) => valueFmt(v),
    })
    ys.push(
      keys.map((k) => {
        const b = merged.get(k)
        return b ? b.v : 0
      }),
    )
  }
  return { keys, ys, defs }
}

type ModelStat = {
  key: string
  parts: number
  thinkMs: number
  tokens: number
  /** 该模型是否可展示 token（接口报数或参与 GLM 计数） */
  hasTokens: boolean
  cost: number
}

type ThinkKpis = {
  tokens: number
  thinkMs: number
  parts: number
  cost: number
  tokenSubExact: string
  tokenSubEstimate: string
  byModel: ModelStat[]
}

function buildKpis(rows: readonly ThinkingRow[], exact: boolean, marks: MarkMap): ThinkKpis {
  let tokens = 0
  let thinkMs = 0
  let parts = 0
  let reported = 0
  let counted = 0
  const byModel = new Map<string, ModelStat>()
  for (const r of rows) {
    const v = rowTokenValue(r, exact)
    tokens += v
    thinkMs += r.thinkMs
    parts += r.parts
    reported += r.reportedTokens
    counted += r.countedTokens
    const gk = resolveGroupKey(r.modelId, 'name', marks)
    let m = byModel.get(gk)
    if (!m) {
      m = { key: gk, parts: 0, thinkMs: 0, tokens: 0, hasTokens: false, cost: 0 }
      byModel.set(gk, m)
    }
    m.parts += r.parts
    m.thinkMs += r.thinkMs
    m.tokens += v
    // 报数模型恒可展示；GLM 行以 chars 标记参与计数
    if (r.reportedTokens > 0 || r.chars > 0) m.hasTokens = true
    m.cost += costFor(r.modelId, {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: v,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })
  }
  const list = [...byModel.values()].sort((a, b) => b.tokens - a.tokens || b.thinkMs - a.thinkMs)
  return {
    tokens,
    thinkMs,
    parts,
    cost: list.reduce((s, m) => s + m.cost, 0),
    tokenSubExact: `接口报数 ${formatFull(reported)} · GLM 分词器计数 ${formatFull(counted)}`,
    tokenSubEstimate: `接口报数 ${formatFull(reported)} · GLM 按 ${ESTIMATE_CHARS_PER_TOKEN} 字符/token 估算`,
    byModel: list,
  }
}
