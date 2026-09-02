import { useMemo, useState } from 'preact/hooks'
import uPlot from 'uplot'
import { IosButton } from '../ui/ios-button.tsx'
import { KpiCard } from '../ui/kpi-card.tsx'
import { DataTable } from '../ui/data-table.tsx'
import { SegmentedControl } from '../ui/segmented-control.tsx'
import { RangeSelectorTabs, RangeSelectorPanelForBelow, useRangeSelectorState } from '../ui/range-selector.tsx'
import { UPlotChart } from '../ui/uplot-chart.tsx'
import { useQuery } from '../lib/use-query.ts'
import { navigate } from '../lib/router.ts'
import { QUERIES, rangeSignature, shapeByProviderModel } from '../db/queries.ts'
import type { OpenedDb } from '../db/client.ts'
import type { ByProviderModelRow } from '../db/types.ts'
import {
  type GroupMode,
  type GroupedModelRow,
  marksSignature,
  resolveProviderModelGroups,
  useCustomModels,
  useMarks,
} from '../lib/model-groups.ts'
import { useRange } from '../lib/range-context.tsx'
import {
  formatCount,
  formatDuration,
  formatPct,
  formatRMB,
  formatTokensPerSecondCompact,
} from '../lib/format.ts'

export function ProviderDetailPage({
  db,
  providerId,
}: {
  db: OpenedDb
  providerId: string
}) {
  const [mode, setMode] = useState<GroupMode>('name')
  const { range, setPreset, setCustom } = useRange()
  const rs = useRangeSelectorState({ value: range, onPreset: setPreset, onCustom: setCustom })
  const marks = useMarks()
  const custom = useCustomModels()

  const state = useQuery<{
    rows: ByProviderModelRow[]
    grouped: GroupedModelRow[]
  }>(
    db,
    `provider-detail:${providerId}:${rangeSignature(range)}:${marksSignature(marks, custom)}`,
    async (d) => {
      const q = QUERIES.byProviderModel(range, providerId)
      const r = await d.select(q.sql, q.bind)
      const rows = shapeByProviderModel(r)
      return { rows, grouped: resolveProviderModelGroups(rows, mode, marks) }
    },
  )

  const topModels = useMemo(() => {
    if (state.kind !== 'ok') return []
    const sorted = [...state.data.grouped].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 10)
    return sorted
  }, [state])

  const kpi = useMemo(() => {
    if (state.kind !== 'ok') return null
    return state.data.rows.reduce(
      (acc, r) => {
        acc.calls += r.calls
        acc.totalTokens += r.totalTokens
        acc.speedOutputTokens += r.speedOutputTokens
        acc.speedDurationMs += r.speedDurationMs
        acc.speedSampleCount += r.speedSampleCount
        acc.ttftSumMs += r.ttftSumMs
        acc.ttftSampleCount += r.ttftSampleCount
        acc.totalDurationMs += r.totalDurationMs
        acc.durationSampleCount += r.durationSampleCount
        acc.cost += r.cost
        return acc
      },
      {
        calls: 0,
        totalTokens: 0,
        speedOutputTokens: 0,
        speedDurationMs: 0,
        speedSampleCount: 0,
        ttftSumMs: 0,
        ttftSampleCount: 0,
        totalDurationMs: 0,
        durationSampleCount: 0,
        cost: 0,
      },
    )
  }, [state])

  return (
    <div class="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <IosButton tone="secondary" size="compact" onClick={() => navigate('by-provider')}>
          ‹ 返回
        </IosButton>
        <h1 class="page__title mono" style={{ margin: 0, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {providerId}
        </h1>
        <SegmentedControl<GroupMode>
          value={mode}
          onChange={setMode}
          ariaLabel="聚合方式"
          className="section__control"
          items={[
            { id: 'id', label: '按ID' },
            { id: 'name', label: '按名字聚合' },
          ]}
        />
        <RangeSelectorTabs state={rs} ariaLabel="时间范围" />
      </div>

      <RangeSelectorPanelForBelow state={rs} />

      {state.kind === 'loading' && <div class="app-banner">加载中…</div>}
      {state.kind === 'error' && <div class="app-banner app-banner--error">{state.error}</div>}

      {state.kind === 'ok' && kpi && (
        <>
          <div class="kpi-grid kpi-grid--3">
            <KpiCard label="总 token" value={formatCount(kpi.totalTokens)} tone="blue" />
            <KpiCard label="调用数" value={formatCount(kpi.calls)} />
            <KpiCard label="模型数" value={formatCount(state.data.grouped.length)} />
            <KpiCard
              label="平均输出速度"
              value={
                kpi.speedDurationMs > 0
                  ? formatTokensPerSecondCompact((kpi.speedOutputTokens / kpi.speedDurationMs) * 1000)
                  : '—'
              }
              tone="purple"
            />
            <KpiCard
              label="平均 TTFT"
              value={kpi.ttftSampleCount > 0 ? formatDuration(kpi.ttftSumMs / kpi.ttftSampleCount) : '—'}
              tone="green"
              sub={kpi.ttftSampleCount === 0 ? '当前数据未记录 time_to_first_token_ms' : `${formatCount(kpi.ttftSampleCount)} 次有效样本`}
            />
            <KpiCard
              label="大致成本"
              value={formatRMB(kpi.cost)}
              tone="orange"
            />
          </div>

          {topModels.length > 0 && (
            <div class="section">
              <h2 class="section__title">Top 模型速度对比</h2>
              <UPlotChart
                data={[
                  topModels.map((_, i) => i),
                  topModels.map((r) => r.avgOutputSpeed ?? 0),
                ]}
                time={false}
                height={200}
                seriesDefs={barSeriesDefs}
                yFormat={(v) => formatTokensPerSecondCompact(v)}
                xFormat={(v) => topModels[Math.round(v)]?.displayName ?? ''}
              />
            </div>
          )}

          <div class="section">
            <DataTable
              columns={columns}
              rows={state.data.grouped}
              rowKey={(r) => r.groupKey}
              emptyMessage="没有数据"
              onRowClick={(r) =>
                navigate(
                  `provider-model/${encodeURIComponent(providerId)}/${encodeURIComponent(r.groupKey)}`,
                )
              }
              stickyFirstColumn="240px"
            />
          </div>
        </>
      )}
    </div>
  )
}

const barSeriesDefs = [
  {
    label: '输出速度 (tok/s)',
    stroke: '#1f6ec7',
    width: 1.4,
    fill: 'rgba(31, 110, 199, 0.18)',
    paths: uPlot.paths!.bars!({ size: [0.75, 100] }),
    points: { show: false },
    value: (_u: unknown, _raw: unknown, v: number | null) =>
      v == null || v === 0 ? '—' : formatTokensPerSecondCompact(v),
  },
]

const columns = [
  {
    key: 'model',
    header: '模型分组',
    width: '220px',
    render: (r: GroupedModelRow) => (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontWeight: 600 }}>{r.displayName}</span>
        <span style={{ fontSize: 10, color: '#8a8a90' }} class="mono">
          {r.modelIds.join(' · ')}
        </span>
      </div>
    ),
  },
  {
    key: 'calls',
    header: '调用',
    align: 'right' as const,
    width: '70px',
    render: (r: GroupedModelRow) => formatCount(r.calls),
  },
  {
    key: 'total',
    header: '总 token',
    align: 'right' as const,
    width: '90px',
    render: (r: GroupedModelRow) => formatCount(r.totalTokens),
  },
  {
    key: 'cache_hit',
    header: '缓存命中率',
    align: 'right' as const,
    width: '90px',
    render: (r: GroupedModelRow) => formatPct(r.cacheHitRate, 1),
  },
  {
    key: 'speed',
    header: '输出速度',
    align: 'right' as const,
    width: '85px',
    render: (r: GroupedModelRow) =>
      r.avgOutputSpeed != null ? formatTokensPerSecondCompact(r.avgOutputSpeed) : '—',
  },
  {
    key: 'ttft',
    header: '首 token',
    align: 'right' as const,
    width: '75px',
    render: (r: GroupedModelRow) => (r.avgTtftMs != null ? formatDuration(r.avgTtftMs) : '—'),
  },
  {
    key: 'duration',
    header: '平均耗时',
    align: 'right' as const,
    width: '75px',
    render: (r: GroupedModelRow) =>
      r.avgDurationMs != null ? formatDuration(r.avgDurationMs) : '—',
  },
  {
    key: 'cost',
    header: '大致成本',
    align: 'right' as const,
    width: '95px',
    render: (r: GroupedModelRow) => formatRMB(r.cost),
  },
]
