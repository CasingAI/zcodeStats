// 模型分组详情：KPI + uPlot 日趋势 + 0-23 小时分布。
// 路由：#/model/<encodeURIComponent(分组名)>

import { useState } from 'preact/hooks'
import uPlot from 'uplot'
import { IosButton } from '../ui/ios-button.tsx'
import { KpiCard } from '../ui/kpi-card.tsx'
import { SegmentedControl } from '../ui/segmented-control.tsx'
import { UPlotChart, toTimeAlignedData } from '../ui/uplot-chart.tsx'
import { useQuery } from '../lib/use-query.ts'
import { navigate } from '../lib/router.ts'
import {
  QUERIES,
  shapeByDay,
  shapeByDayByModel,
  aggregateCostByDay,
  shapeByHour,
  shapeByModel,
  type ParamQuery,
  type Range,
} from '../db/queries.ts'
import type { OpenedDb } from '../db/client.ts'
import type { ByDayRow, ByModelRow } from '../db/types.ts'
import {
  marksSignature,
  normalizeModelName,
  resolveGroupKey,
  useMarks,
  useCustomModels,
} from '../lib/model-groups.ts'
import { formatCount, formatPct, formatRMB } from '../lib/format.ts'

type ModelDetailData = {
  ids: string[]
  calls: number
  totalTokens: number
  errorCount: number
  cacheHitRate: number
  cost: number
  daily: ByDayRow[]
  /** 0-23 时的 token 聚合（对 weekday 折叠） */
  hourTokens: number[]
  hourCalls: number[]
}

export function ModelDetailPage({ db, group }: { db: OpenedDb; group: string }) {
  const [range, setRange] = useState<Range>('30d')
  const marks = useMarks()
  const custom = useCustomModels()

  const state = useQuery<ModelDetailData>(
    db,
    `model-detail:${group}:${range}:${marksSignature(marks, custom)}`,
    async (d) => {
      // 先拿 range 内的全部 id 行，解析出该分组下的 model_id 集合
      const all: ByModelRow[] = shapeByModel(
        await d.select(QUERIES.byModel(range).sql, QUERIES.byModel(range).bind),
      )
      // 命中规则与列表页两种聚合方式保持一致：id 完全相等、名字归一化相等、
      // 或标记值相等，任一满足即归入该分组。
      const ids = all
        .map((r) => r.modelId)
        .filter(
          (id) =>
            id !== '' &&
            (id === group ||
              normalizeModelName(id) === group ||
              resolveGroupKey(id, 'name', marks) === group),
        )
      const own = all.filter((r) => ids.includes(r.modelId))

      let calls = 0
      let totalTokens = 0
      let errorCount = 0
      let inputTokens = 0
      let cacheCreation = 0
      let cacheRead = 0
      let cost = 0
      for (const r of own) {
        calls += r.calls
        totalTokens += r.totalTokens
        errorCount += r.errorCount
        inputTokens += r.inputTokens
        cacheCreation += r.cacheCreationTokens
        cacheRead += r.cacheReadTokens
        cost += r.cost
      }
      const cacheHitRate =
        inputTokens + cacheCreation > 0 ? cacheRead / (inputTokens + cacheCreation) : 0

      const dayQ: ParamQuery = QUERIES.byDay(range, ids)
      const dbyMQ: ParamQuery = QUERIES.byDayByModel(range)
      const [dayR, dbyMR, hourR] = await Promise.all([
        d.select(dayQ.sql, dayQ.bind),
        d.select(dbyMQ.sql, dbyMQ.bind),
        d.select(QUERIES.byHour(range, ids).sql, QUERIES.byHour(range, ids).bind),
      ])
      // byDayByModel 是全量；按 ids 过滤后再折叠到 day → cost
      const dbyMRows = shapeByDayByModel(dbyMR).filter(
        (r) => r.modelId !== '' && ids.includes(r.modelId),
      )
      const costMap = aggregateCostByDay(dbyMRows)
      const daily = shapeByDay(dayR, costMap)
      const grid = shapeByHour(hourR)

      // weekday×hour 折叠成 0-23
      const hourTokens = new Array<number>(24).fill(0)
      const hourCalls = new Array<number>(24).fill(0)
      for (const c of grid.cells) {
        hourTokens[c.hour]! += c.totalTokens
        hourCalls[c.hour]! += c.calls
      }

      return { ids, calls, totalTokens, errorCount, cacheHitRate, cost, daily, hourTokens, hourCalls }
    },
  )

  return (
    <div class="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <IosButton tone="secondary" size="compact" onClick={() => navigate('by-model')}>
          ‹ 返回
        </IosButton>
        <h1 class="page__title mono" style={{ margin: 0, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group}</h1>
        <SegmentedControl<Range>
          value={range}
          onChange={setRange}
          ariaLabel="时间范围"
          items={[
            { id: '7d', label: '近7天' },
            { id: '30d', label: '近30天' },
            { id: 'all', label: '全部' },
          ]}
        />
      </div>
      <p
        class="page__subtitle mono"
        style={{ wordBreak: 'break-all', marginTop: -6 }}
      >
        {state.kind === 'ok' ? dedupPreserveOrder(state.data.ids).join(' · ') : '…'}
      </p>

      {state.kind === 'loading' && <div class="app-banner">加载中…</div>}
      {state.kind === 'error' && <div class="app-banner app-banner--error">{state.error}</div>}

      {state.kind === 'ok' && state.data.ids.length === 0 && (
        <div class="app-banner">没有匹配该分组的模型（分组名可能已改动）</div>
      )}

      {state.kind === 'ok' && state.data.ids.length > 0 && (
        <>
          <div class="kpi-grid kpi-grid--3">
            <KpiCard label="总 token" value={formatCount(state.data.totalTokens)} tone="blue" />
            <KpiCard label="调用数" value={formatCount(state.data.calls)} />
            <KpiCard label="缓存命中率" value={formatPct(state.data.cacheHitRate, 1)} tone="green" />
            <KpiCard
              label="错误数"
              value={state.data.errorCount > 0 ? formatCount(state.data.errorCount) : '0'}
              tone={state.data.errorCount > 0 ? 'red' : 'default'}
            />
            <KpiCard
              label="大致成本"
              value={formatRMB(state.data.cost)}
              tone="orange"
              sub="按价目表 / 标记估算"
            />
          </div>

          <div class="section">
            <h2 class="section__title">日趋势</h2>
            {state.data.daily.length === 0 ? (
              <div class="app-banner">所选时间窗内无数据</div>
            ) : (
              <UPlotChart
                data={toTimeAlignedData(state.data.daily.map((r) => r.day), [
                  state.data.daily.map((r) => r.totalTokens),
                  state.data.daily.map((r) => r.cacheReadTokens),
                ])}
                time
                height={240}
                seriesDefs={dailySeriesDefs}
                yFormat={(v) => (Math.abs(v) >= 1000 ? formatCount(v) : String(Math.round(v)))}
                xFormat={(v) => {
                  const d = new Date(v * 1000)
                  return `${d.getUTCFullYear() % 100}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`
                }}
              />
            )}
          </div>

          <div class="section">
            <h2 class="section__title">小时分布（0–23 时聚合）</h2>
            <UPlotChart
              data={[
                Array.from({ length: 24 }, (_, i) => i),
                state.data.hourTokens,
              ]}
              time={false}
              height={200}
              seriesDefs={hourSeriesDefs}
              yFormat={(v) => (Math.abs(v) >= 1000 ? formatCount(v) : String(Math.round(v)))}
              xFormat={(v) => `${String(Math.round(v)).padStart(2, '0')}时`}
            />
          </div>
        </>
      )}
    </div>
  )
}

const dailySeriesDefs = [
  {
    label: '总 token',
    stroke: '#1f6ec7',
    width: 2,
    fill: 'rgba(47, 135, 226, 0.08)',
    value: (_u: unknown, _raw: unknown, v: number | null) => (v == null ? '—' : formatCount(v)),
  },
  {
    label: '缓存读取',
    stroke: '#34c759',
    width: 1.5,
    value: (_u: unknown, _raw: unknown, v: number | null) => (v == null ? '—' : formatCount(v)),
  },
]

const hourSeriesDefs = [
  {
    label: 'token',
    stroke: '#8e6cc7',
    width: 1.4,
    fill: 'rgba(142, 108, 199, 0.25)',
    paths: uPlot.paths!.bars!({ size: [0.75, 100] }),
    points: { show: false },
    value: (_u: unknown, _raw: unknown, v: number | null) => (v == null ? '—' : formatCount(v)),
  },
]

function dedupPreserveOrder(arr: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of arr) {
    if (!seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  return out
}
