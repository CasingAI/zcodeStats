// 供应商 × 模型 详情页：KPI + 日趋势 + 小时分布。
// 路由：#/provider-model/<encodeURIComponent(providerId)>/<encodeURIComponent(modelId)>

import uPlot from 'uplot'
import { IosButton } from '../ui/ios-button.tsx'
import { KpiCard } from '../ui/kpi-card.tsx'
import { RangeSelectorTabs, RangeSelectorPanelForBelow, useRangeSelectorState } from '../ui/range-selector.tsx'
import { UPlotChart, toTimeAlignedData } from '../ui/uplot-chart.tsx'
import { useQuery } from '../lib/use-query.ts'
import { navigate } from '../lib/router.ts'
import {
  QUERIES,
  rangeSignature,
  shapeByDayByProviderModel,
  shapeByHour,
} from '../db/queries.ts'
import type { OpenedDb } from '../db/client.ts'
import type { ByDayRow } from '../db/types.ts'
import { useRange } from '../lib/range-context.tsx'
import {
  formatCount,
  formatDuration,
  formatPct,
  formatRMB,
  formatTokensPerSecond,
} from '../lib/format.ts'
import { costFor } from '../lib/pricing.ts'

type ProviderModelData = {
  providerId: string
  modelId: string
  calls: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  errorCount: number
  cacheHitRate: number
  cost: number
  avgOutputSpeed: number | null
  avgTtftMs: number | null
  avgDurationMs: number | null
  speedSampleCount: number
  ttftSampleCount: number
  durationSampleCount: number
  daily: ByDayRow[]
  hourSpeed: (number | null)[]
  hourTtft: (number | null)[]
}

export function ProviderModelDetailPage({
  db,
  providerId,
  modelId,
}: {
  db: OpenedDb
  providerId: string
  modelId: string
}) {
  const { range, setPreset, setCustom } = useRange()
  const rs = useRangeSelectorState({ value: range, onPreset: setPreset, onCustom: setCustom })

  const state = useQuery<ProviderModelData>(
    db,
    `provider-model-detail:${providerId}:${modelId}:${rangeSignature(range)}`,
    async (d) => {
      const dayQ = QUERIES.byDayByProviderModel(range, providerId, modelId)
      const hourQ = QUERIES.byHourByProviderModel(range, providerId, modelId)
      const [dayR, hourR] = await Promise.all([
        d.select(dayQ.sql, dayQ.bind),
        d.select(hourQ.sql, hourQ.bind),
      ])
      const daily = shapeByDayByProviderModel(dayR)
      const grid = shapeByHour(hourR)

      let calls = 0
      let totalTokens = 0
      let inputTokens = 0
      let outputTokens = 0
      let reasoningTokens = 0
      let cacheReadTokens = 0
      let cacheCreationTokens = 0
      let errorCount = 0
      let speedOutputTokens = 0
      let speedDurationMs = 0
      let speedSampleCount = 0
      let ttftSumMs = 0
      let ttftSampleCount = 0
      let totalDurationMs = 0
      let durationSampleCount = 0
      // 按 hour 聚合获取总调用数与总 token
      for (const c of grid.cells) {
        calls += c.calls
        totalTokens += c.totalTokens
      }
      for (const r of daily) {
        inputTokens += r.inputTokens
        outputTokens += r.outputTokens
        reasoningTokens += r.reasoningTokens
        cacheReadTokens += r.cacheReadTokens
        cacheCreationTokens += r.cacheCreationTokens
        speedOutputTokens += r.speedOutputTokens
        speedDurationMs += r.speedDurationMs
        speedSampleCount += r.speedSampleCount
        ttftSumMs += r.ttftSumMs
        ttftSampleCount += r.ttftSampleCount
        totalDurationMs += r.totalDurationMs
        durationSampleCount += r.durationSampleCount
      }
      errorCount = 0 // byDayByProviderModel 未返回 errorCount，暂缺
      const cacheHitRate =
        inputTokens + cacheCreationTokens > 0
          ? cacheReadTokens / (inputTokens + cacheCreationTokens)
          : 0

      const hourSpeed: (number | null)[] = Array(24).fill(null)
      const hourTtft: (number | null)[] = Array(24).fill(null)
      for (const c of grid.cells) {
        hourSpeed[c.hour] = c.speedDurationMs > 0 ? (c.speedOutputTokens / c.speedDurationMs) * 1000 : null
        hourTtft[c.hour] = c.ttftSampleCount > 0 ? c.ttftSumMs / c.ttftSampleCount : null
      }

      return {
        providerId,
        modelId,
        calls,
        totalTokens,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cacheReadTokens,
        cacheCreationTokens,
        errorCount,
        cacheHitRate,
        cost: costFor(modelId, {
          inputTokens,
          outputTokens,
          reasoningTokens,
          cacheReadTokens,
          cacheCreationTokens,
        }),
        avgOutputSpeed: speedDurationMs > 0 ? (speedOutputTokens / speedDurationMs) * 1000 : null,
        avgTtftMs: ttftSampleCount > 0 ? ttftSumMs / ttftSampleCount : null,
        avgDurationMs: durationSampleCount > 0 ? totalDurationMs / durationSampleCount : null,
        speedSampleCount,
        ttftSampleCount,
        durationSampleCount,
        daily,
        hourSpeed,
        hourTtft,
      }
    },
  )

  return (
    <div class="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <IosButton
          tone="secondary"
          size="compact"
          onClick={() => navigate(`provider/${encodeURIComponent(providerId)}`)}
        >
          ‹ 返回
        </IosButton>
        <h1
          class="page__title mono"
          style={{
            margin: 0,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {providerId} / {modelId}
        </h1>
        <RangeSelectorTabs state={rs} ariaLabel="时间范围" />
      </div>

      <RangeSelectorPanelForBelow state={rs} />

      {state.kind === 'loading' && <div class="app-banner">加载中…</div>}
      {state.kind === 'error' && <div class="app-banner app-banner--error">{state.error}</div>}

      {state.kind === 'ok' && (
        <>
          <div class="kpi-grid kpi-grid--3">
            <KpiCard label="总 token" value={formatCount(state.data.totalTokens)} tone="blue" />
            <KpiCard label="调用数" value={formatCount(state.data.calls)} />
            <KpiCard label="缓存命中率" value={formatPct(state.data.cacheHitRate, 1)} tone="green" />
            <KpiCard
              label="平均输出速度"
              value={
                state.data.avgOutputSpeed != null
                  ? formatTokensPerSecond(state.data.avgOutputSpeed)
                  : '—'
              }
              tone="purple"
              sub={`${formatCount(state.data.speedSampleCount)} 次有效样本`}
            />
            <KpiCard
              label="平均 TTFT"
              value={
                state.data.avgTtftMs != null ? formatDuration(state.data.avgTtftMs) : '—'
              }
              tone="green"
              sub={
                state.data.ttftSampleCount === 0
                  ? '当前数据未记录 time_to_first_token_ms'
                  : `${formatCount(state.data.ttftSampleCount)} 次有效样本`
              }
            />
            <KpiCard
              label="大致成本"
              value={formatRMB(state.data.cost)}
              tone="orange"
            />
          </div>

          <div class="section">
            <h2 class="section__title">输出速度日趋势</h2>
            {state.data.daily.length === 0 ? (
              <div class="app-banner">所选时间窗内无数据</div>
            ) : (
              <UPlotChart
                data={toTimeAlignedData(state.data.daily.map((r) => r.day), [
                  state.data.daily.map((r) => r.avgOutputSpeed ?? 0),
                ])}
                time
                height={220}
                seriesDefs={dailySpeedSeriesDefs}
                yFormat={(v) => formatTokensPerSecond(v)}
                xFormat={(v) => {
                  const d = new Date(v * 1000)
                  return `${d.getUTCFullYear() % 100}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`
                }}
              />
            )}
          </div>

          <div class="section">
            <h2 class="section__title">TTFT 日趋势</h2>
            {state.data.daily.length === 0 ? (
              <div class="app-banner">所选时间窗内无数据</div>
            ) : (
              <UPlotChart
                data={toTimeAlignedData(state.data.daily.map((r) => r.day), [
                  state.data.daily.map((r) => r.avgTtftMs ?? 0),
                ])}
                time
                height={220}
                seriesDefs={dailyTtftSeriesDefs}
                yFormat={(v) => formatDuration(v)}
                xFormat={(v) => {
                  const d = new Date(v * 1000)
                  return `${d.getUTCFullYear() % 100}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`
                }}
              />
            )}
          </div>

          <div class="section">
            <h2 class="section__title">输出速度小时分布（0–23 时聚合）</h2>
            <UPlotChart
              data={[
                Array.from({ length: 24 }, (_, i) => i),
                state.data.hourSpeed.map((v) => v ?? 0),
              ]}
              time={false}
              height={200}
              seriesDefs={hourSpeedSeriesDefs}
              yFormat={(v) => formatTokensPerSecond(v)}
              xFormat={(v) => `${String(Math.round(v)).padStart(2, '0')}时`}
            />
          </div>

          <div class="section">
            <h2 class="section__title">TTFT 小时分布（0–23 时聚合）</h2>
            <UPlotChart
              data={[
                Array.from({ length: 24 }, (_, i) => i),
                state.data.hourTtft.map((v) => v ?? 0),
              ]}
              time={false}
              height={200}
              seriesDefs={hourTtftSeriesDefs}
              yFormat={(v) => formatDuration(v)}
              xFormat={(v) => `${String(Math.round(v)).padStart(2, '0')}时`}
            />
          </div>
        </>
      )}
    </div>
  )
}

const dailySpeedSeriesDefs = [
  {
    label: '输出速度 (tok/s)',
    stroke: '#8e6cc7',
    width: 2,
    fill: 'rgba(142, 108, 199, 0.12)',
    value: (_u: unknown, _raw: unknown, v: number | null) =>
      v == null || v === 0 ? '—' : formatTokensPerSecond(v),
  },
]

const dailyTtftSeriesDefs = [
  {
    label: 'TTFT (ms)',
    stroke: '#34c759',
    width: 2,
    fill: 'rgba(52, 199, 89, 0.12)',
    value: (_u: unknown, _raw: unknown, v: number | null) =>
      v == null || v === 0 ? '—' : formatDuration(v),
  },
]

const hourSpeedSeriesDefs = [
  {
    label: '输出速度 (tok/s)',
    stroke: '#1f6ec7',
    width: 1.4,
    fill: 'rgba(31, 110, 199, 0.12)',
    paths: uPlot.paths!.bars!({ size: [0.75, 100] }),
    points: { show: false },
    value: (_u: unknown, _raw: unknown, v: number | null) =>
      v == null || v === 0 ? '—' : formatTokensPerSecond(v),
  },
]

const hourTtftSeriesDefs = [
  {
    label: 'TTFT (ms)',
    stroke: '#34c759',
    width: 1.4,
    fill: 'rgba(52, 199, 89, 0.12)',
    paths: uPlot.paths!.bars!({ size: [0.75, 100] }),
    points: { show: false },
    value: (_u: unknown, _raw: unknown, v: number | null) =>
      v == null || v === 0 ? '—' : formatDuration(v),
  },
]
