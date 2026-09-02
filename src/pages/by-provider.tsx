import { useMemo } from 'preact/hooks'
import { DataTable } from '../ui/data-table.tsx'
import { KpiCard } from '../ui/kpi-card.tsx'
import { IosButton } from '../ui/ios-button.tsx'
import { RangeSelectorTabs, RangeSelectorPanelForBelow, useRangeSelectorState } from '../ui/range-selector.tsx'
import { useQuery } from '../lib/use-query.ts'
import { navigate } from '../lib/router.ts'
import { QUERIES, rangeSignature, shapeByProvider } from '../db/queries.ts'
import type { OpenedDb } from '../db/client.ts'
import type { ByProviderRow } from '../db/types.ts'
import { useRange } from '../lib/range-context.tsx'
import {
  formatCount,
  formatDuration,
  formatPct,
  formatTokensPerSecondCompact,
} from '../lib/format.ts'

export function ByProviderPage({ db }: { db: OpenedDb }) {
  const { range, setPreset, setCustom } = useRange()
  const rs = useRangeSelectorState({ value: range, onPreset: setPreset, onCustom: setCustom })

  const state = useQuery<ByProviderRow[]>(
    db,
    `by-provider:${rangeSignature(range)}`,
    async (d) => {
      const r = await d.select(QUERIES.byProvider(range).sql, QUERIES.byProvider(range).bind)
      return shapeByProvider(r)
    },
  )

  const providerCount = useMemo(() => {
    return state.kind === 'ok' ? state.data.length : 0
  }, [state])

  return (
    <div class="page">
      <div class="section__header">
        <div>
          <h1 class="page__title">按供应商</h1>
          <p class="page__subtitle">点击行查看该供应商下的模型明细与趋势</p>
        </div>
        <RangeSelectorTabs state={rs} ariaLabel="时间范围" />
      </div>

      <RangeSelectorPanelForBelow state={rs} />

      {state.kind === 'ok' && state.data.length > 0 && (
        <div class="kpi-grid kpi-grid--3" style={{ marginBottom: 12 }}>
          <KpiCard label="供应商数" value={formatCount(providerCount)} tone="blue" />
          <KpiCard
            label="总调用数"
            value={formatCount(state.data.reduce((s, r) => s + r.calls, 0))}
          />
          <KpiCard
            label="总 token"
            value={formatCount(state.data.reduce((s, r) => s + r.totalTokens, 0))}
          />
        </div>
      )}

      <div class="section">
        {state.kind === 'loading' && (
          <DataTable columns={columns} rows={[]} rowKey={() => ''} loading />
        )}
        {state.kind === 'error' && <div class="app-banner app-banner--error">{state.error}</div>}
        {state.kind === 'ok' && (
          <DataTable
            columns={columns}
            rows={state.data}
            rowKey={(r) => r.providerId}
            emptyMessage="没有数据"
            onRowClick={(r) => navigate(`provider/${encodeURIComponent(r.providerId)}`)}
          />
        )}
      </div>
    </div>
  )
}

const columns = [
  {
    key: 'provider',
    header: '供应商',
    width: '220px',
    render: (r: ByProviderRow) => (
      <span class="mono" style={{ fontWeight: 600 }}>
        {r.providerId}
      </span>
    ),
  },
  {
    key: 'calls',
    header: '调用',
    align: 'right' as const,
    width: '80px',
    render: (r: ByProviderRow) => formatCount(r.calls),
  },
  {
    key: 'total',
    header: '总 token',
    align: 'right' as const,
    width: '90px',
    render: (r: ByProviderRow) => formatCount(r.totalTokens),
  },
  {
    key: 'input',
    header: '输入',
    align: 'right' as const,
    width: '80px',
    render: (r: ByProviderRow) => formatCount(r.inputTokens),
  },
  {
    key: 'cache_w',
    header: '缓存写',
    align: 'right' as const,
    width: '80px',
    render: (r: ByProviderRow) => formatCount(r.cacheCreationTokens),
  },
  {
    key: 'cache_r',
    header: '缓存读',
    align: 'right' as const,
    width: '80px',
    render: (r: ByProviderRow) => formatCount(r.cacheReadTokens),
  },
  {
    key: 'cache_hit',
    header: '缓存命中率',
    align: 'right' as const,
    width: '90px',
    render: (r: ByProviderRow) => formatPct(r.cacheHitRate, 1),
  },
  {
    key: 'speed',
    header: '输出速度',
    align: 'right' as const,
    width: '85px',
    render: (r: ByProviderRow) =>
      r.avgOutputSpeed != null ? formatTokensPerSecondCompact(r.avgOutputSpeed) : '—',
  },
  {
    key: 'ttft',
    header: '首 token',
    align: 'right' as const,
    width: '75px',
    render: (r: ByProviderRow) => (r.avgTtftMs != null ? formatDuration(r.avgTtftMs) : '—'),
  },
  {
    key: 'duration',
    header: '平均耗时',
    align: 'right' as const,
    width: '75px',
    render: (r: ByProviderRow) =>
      r.avgDurationMs != null ? formatDuration(r.avgDurationMs) : '—',
  },
  {
    key: 'action',
    header: '',
    width: '70px',
    render: () => <IosButton tone="secondary" size="compact">详情</IosButton>,
  },
]
