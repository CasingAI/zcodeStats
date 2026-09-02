import { KpiCard } from '../ui/kpi-card.tsx'
import { RangeSelectorTabs, RangeSelectorPanelForBelow, useRangeSelectorState } from '../ui/range-selector.tsx'
import { useQuery } from '../lib/use-query.ts'
import { QUERIES, rangeSignature, shapeByModel, shapeOverview } from '../db/queries.ts'
import type { OpenedDb } from '../db/client.ts'
import type { OverviewKpis } from '../db/types.ts'
import { marksSignature, useMarks, useCustomModels } from '../lib/model-groups.ts'
import { useRange } from '../lib/range-context.tsx'
import {
  formatCount,
  formatDuration,
  formatFull,
  formatPct,
  formatRMB,
  formatTokensPerSecond,
} from '../lib/format.ts'

export function OverviewPage({ db }: { db: OpenedDb }) {
  const { range, setPreset, setCustom } = useRange()
  const rs = useRangeSelectorState({ value: range, onPreset: setPreset, onCustom: setCustom })
  const marks = useMarks()
  const custom = useCustomModels()
  const state = useQuery<OverviewKpis>(
    db,
    `overview:${rangeSignature(range)}:${marksSignature(marks, custom)}`,
    async (d) => {
      const [ov, t, m] = await Promise.all([
        d.select(QUERIES.overview(range).sql, QUERIES.overview(range).bind),
        d.select(QUERIES.toolOverview(range).sql, QUERIES.toolOverview(range).bind),
        d.select(QUERIES.byModel(range).sql, QUERIES.byModel(range).bind),
      ])
      const byModelRows = shapeByModel(m)
      return shapeOverview(ov, t, byModelRows)
    },
  )

  if (state.kind === 'loading') {
    return (
      <div class="page">
        <h1 class="page__title">总览</h1>
        <KpiGrid loading />
      </div>
    )
  }
  if (state.kind === 'error') {
    return (
      <div class="page">
        <h1 class="page__title">总览</h1>
        <div class="app-banner app-banner--error">{state.error}</div>
      </div>
    )
  }
  const k = state.data
  const errorRate = k.modelCallCount > 0 ? k.modelErrorCount / k.modelCallCount : 0
  const firstSeenStr = k.firstSeen ? new Date(k.firstSeen).toISOString().slice(0, 10) : '—'
  const lastSeenStr = k.lastSeen ? new Date(k.lastSeen).toISOString().slice(0, 10) : '—'
  return (
    <div class="page">
      <div class="section__header">
        <div>
          <h1 class="page__title">总览</h1>
          <p class="page__subtitle">
            {firstSeenStr} → {lastSeenStr} · 活跃 {k.activeDays} 天
          </p>
        </div>
        <RangeSelectorTabs state={rs} ariaLabel="时间范围" className="section__control" />
      </div>

      <RangeSelectorPanelForBelow state={rs} />

      <KpiGrid data={k} errorRate={errorRate} />
      <div class="section">
        <h2 class="section__title">分项明细</h2>
        <BreakdownTable data={k} errorRate={errorRate} />
      </div>
    </div>
  )
}

function KpiGrid(props: { data?: OverviewKpis; errorRate?: number; loading?: boolean }) {
  const { data, errorRate = 0, loading } = props
  return (
    <div class="kpi-grid kpi-grid--3">
      <KpiCard
        label="使用总额 / 累计 token"
        tone="blue"
        loading={loading}
        value={data ? formatFull(data.totalTokens) : ''}
        sub={data ? `${formatCount(data.totalTokens)} tokens` : ''}
      />
      <KpiCard
        label="模型调用"
        tone="default"
        loading={loading}
        value={data ? formatFull(data.modelCallCount) : ''}
        sub={data ? `工具调用 ${formatFull(data.toolCallCount)}` : ''}
      />
      <KpiCard
        label="缓存命中率"
        tone="green"
        loading={loading}
        value={data ? formatPct(data.cacheHitRate) : ''}
        sub={data ? `读 ${formatCount(data.cacheReadTokens)} · 写 ${formatCount(data.cacheCreationTokens)}` : ''}
      />
      <KpiCard
        label="错误率"
        tone={errorRate > 0.05 ? 'red' : 'default'}
        loading={loading}
        value={data ? formatPct(errorRate) : ''}
        sub={data
          ? `错误 ${data.modelErrorCount} · 取消 ${data.cancelCount} · 上下文超限 ${data.contextExceededCount}`
          : ''}
      />
      <KpiCard
        label="重试"
        tone="orange"
        loading={loading}
        value={data ? formatFull(data.retryTotal) : ''}
        sub={data ? '累计重试次数' : ''}
      />
      <KpiCard
        label="输出 token"
        tone="purple"
        loading={loading}
        value={data ? formatFull(data.outputTokens) : ''}
        sub={data ? `含 reasoning ${formatCount(data.reasoningTokens)}` : ''}
      />
      <KpiCard
        label="平均输出速度"
        tone="blue"
        loading={loading}
        value={data ? (data.avgOutputSpeed != null ? formatTokensPerSecond(data.avgOutputSpeed) : '—') : ''}
        sub={data ? `${formatFull(data.speedSampleCount)} 次有效样本` : ''}
      />
      <KpiCard
        label="平均 TTFT"
        tone="green"
        loading={loading}
        value={data ? (data.avgTtftMs != null ? formatDuration(data.avgTtftMs) : '—') : ''}
        sub={data ? (data.ttftSampleCount === 0 ? '当前数据未记录 time_to_first_token_ms' : `${formatFull(data.ttftSampleCount)} 次有效样本`) : ''}
      />
      <KpiCard
        label="平均调用耗时"
        tone="default"
        loading={loading}
        value={data ? (data.avgDurationMs != null ? formatDuration(data.avgDurationMs) : '—') : ''}
        sub={data ? `总耗时 ${formatDuration(data.totalDurationMs)}` : ''}
      />
      <KpiCard
        label="大致成本"
        tone="orange"
        loading={loading}
        value={data ? formatRMB(data.cost) : ''}
        sub={data ? '按内置价目表估算' : ''}
      />
    </div>
  )
}

function BreakdownTable({ data, errorRate: _errorRate }: { data: OverviewKpis; errorRate: number }) {
  const rows: { label: string; value: string; sub?: string }[] = [
    { label: '输入 token', value: formatFull(data.inputTokens), sub: formatCount(data.inputTokens) },
    {
      label: '缓存读取',
      value: formatFull(data.cacheReadTokens),
      sub: `占输入端 ${formatPct(
        data.inputTokens + data.cacheCreationTokens > 0
          ? data.cacheReadTokens / (data.inputTokens + data.cacheCreationTokens)
          : 0,
      )}`,
    },
    { label: '缓存写入', value: formatFull(data.cacheCreationTokens) },
    { label: '输出 token', value: formatFull(data.outputTokens) },
    { label: 'Reasoning', value: formatFull(data.reasoningTokens) },
    { label: '工具调用', value: formatFull(data.toolCallCount), sub: `错误 ${data.toolErrorCount}` },
    { label: '大致成本', value: formatRMB(data.cost), sub: '输入+缓存写+缓存读+输出+reasoning' },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
      {rows.map((r) => (
        <div
          key={r.label}
          style={{
            padding: '10px 12px',
            borderRadius: 6,
            border: '1px solid #d0d0d4',
            background: 'linear-gradient(180deg, #fafafb 0%, #f0f0f3 100%)',
          }}
        >
          <div style={{ fontSize: 11, color: '#6b6b70', fontWeight: 600 }}>{r.label}</div>
          <div
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: '#1a1a1a',
              fontVariantNumeric: 'tabular-nums',
              marginTop: 2,
            }}
          >
            {r.value}
          </div>
          {r.sub && <div style={{ fontSize: 10, color: '#8a8a90', marginTop: 2 }}>{r.sub}</div>}
        </div>
      ))}
    </div>
  )
}

