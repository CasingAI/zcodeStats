import { useMemo, useState } from 'preact/hooks'
import { DataTable } from '../ui/data-table.tsx'
import { KpiCard } from '../ui/kpi-card.tsx'
import { SegmentedControl } from '../ui/segmented-control.tsx'
import {
  RangeSelectorTabs,
  RangeSelectorPanelForBelow,
  useRangeSelectorState,
} from '../ui/range-selector.tsx'
import { useQuery } from '../lib/use-query.ts'
import {
  QUERIES,
  rangeSignature,
  shapeByPromptByModel,
  shapeByPromptSummary,
  aggregateByPrompt,
} from '../db/queries.ts'
import type { OpenedDb } from '../db/client.ts'
import type { ByPromptDetailRow, ByPromptModelRow } from '../db/types.ts'
import {
  type GroupMode,
  type MarkMap,
  applyBuiltin,
  marksSignature,
  resolveGroupKey,
  useCustomModels,
  useMarks,
} from '../lib/model-groups.ts'
import { useRange } from '../lib/range-context.tsx'
import { displayNameOf, isMarkedModel, isRecognizedModel, resolveMatch } from '../lib/pricing.ts'
import { formatCount, formatDuration, formatFull, formatRMB } from '../lib/format.ts'

export function ByPromptPage({ db }: { db: OpenedDb }) {
  const { range, setPreset, setCustom } = useRange()
  const rs = useRangeSelectorState({ value: range, onPreset: setPreset, onCustom: setCustom })
  const marks = useMarks()
  const custom = useCustomModels()
  const [mode, setMode] = useState<GroupMode>('id')
  const [detailSort, setDetailSort] = useState<'time' | 'cost' | 'tokens'>('time')

  const state = useQuery<ByPromptDetailRow[]>(
    db,
    `by-prompt:${rangeSignature(range)}:${marksSignature(marks, custom)}`,
    async (d) => {
      const [bm, sm] = await Promise.all([
        d.select(QUERIES.byPromptByModel(range).sql, QUERIES.byPromptByModel(range).bind),
        d.select(QUERIES.byPromptSummary(range).sql, QUERIES.byPromptSummary(range).bind),
      ])
      return aggregateByPrompt(shapeByPromptByModel(bm), shapeByPromptSummary(sm))
    },
  )

  const grouped: ByPromptModelRow[] = useMemo(() => {
    if (state.kind !== 'ok') return []
    return resolveByPromptGroups(state.data, mode, marks)
  }, [state.kind === 'ok' ? state.data : null, mode, marks])

  const kpis = useMemo(() => {
    if (state.kind !== 'ok') return null
    const data = state.data
    const totalPrompts = data.length
    const totalTokens = data.reduce((s, d) => s + d.totalTokens, 0)
    const totalCost = data.reduce((s, d) => s + d.cost, 0)
    const totalCalls = data.reduce((s, d) => s + d.modelCalls, 0)
    return {
      totalPrompts,
      avgTokens: totalPrompts > 0 ? totalTokens / totalPrompts : 0,
      avgCost: totalPrompts > 0 ? totalCost / totalPrompts : 0,
      avgCalls: totalPrompts > 0 ? totalCalls / totalPrompts : 0,
    }
  }, [state.kind === 'ok' ? state.data : null])

  const sortedDetails = useMemo(() => {
    if (state.kind !== 'ok') return []
    const data = [...state.data]
    if (detailSort === 'cost') data.sort((a, b) => b.cost - a.cost)
    else if (detailSort === 'tokens') data.sort((a, b) => b.totalTokens - a.totalTokens)
    else data.sort((a, b) => (b.firstSeen ?? 0) - (a.firstSeen ?? 0))
    return data.slice(0, 50)
  }, [state.kind === 'ok' ? state.data : null, detailSort])

  const displayMap = useMemo(() => {
    if (state.kind !== 'ok') return new Map<string, string>()
    const map = new Map<string, string>()
    for (const d of state.data) {
      const firstId = d.primaryModelKey
      const builtin = applyBuiltin(firstId)
      let key: string
      if (builtin) {
        key = builtin
      } else {
        const m = resolveMatch(firstId)
        key = m.rule === 'default' ? resolveGroupKey(firstId, mode, marks) : m.matched
      }
      map.set(firstId, displayNameOf(key))
    }
    return map
  }, [state.kind === 'ok' ? state.data : null, mode, marks])

  return (
    <div class="page">
      <div class="section__header">
        <div style={{ minWidth: 0, flex: '1 1 280px' }}>
          <h1 class="page__title">按 Prompt</h1>
          <p class="page__subtitle">
            以 turn 为口径：一次用户输入到系统完整回复视为一个 Prompt；多模型时归入 token 占比最高的主模型
          </p>
        </div>
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
            minWidth: 0,
            flex: '0 1 auto',
          }}
        >
          <RangeSelectorTabs state={rs} ariaLabel="时间范围" className="section__control" />
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
        </div>
      </div>

      <RangeSelectorPanelForBelow state={rs} />

      {state.kind === 'loading' && <KpiGrid loading />}
      {state.kind === 'error' && (
        <div class="app-banner app-banner--error">
          {state.error.includes('turn_id')
            ? `${state.error}（当前数据库版本可能未记录 turn_id，无法按 Prompt 分析）`
            : state.error}
        </div>
      )}
      {state.kind === 'ok' && (
        <>
          <KpiGrid kpis={kpis} />

          <div class="section">
            <h2 class="section__title">按模型平均</h2>
            {grouped.length === 0 ? (
              <div class="app-banner">所选时间范围内没有完整完成的 Prompt</div>
            ) : (
              <DataTable
                columns={modelColumns}
                rows={grouped}
                rowKey={(r) => r.groupKey}
                stickyFirstColumn="240px"
              />
            )}
          </div>

          <div class="section">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <h2 class="section__title">Prompt 明细（Top 50）</h2>
              <SegmentedControl<'time' | 'cost' | 'tokens'>
                value={detailSort}
                onChange={setDetailSort}
                ariaLabel="明细排序"
                className="section__control"
                items={[
                  { id: 'time', label: '按时间' },
                  { id: 'cost', label: '按成本' },
                  { id: 'tokens', label: '按 token' },
                ]}
              />
            </div>
            <DataTable
              columns={detailColumns(displayMap)}
              rows={sortedDetails}
              rowKey={(r) => r.turnId}
              emptyMessage="没有数据"
            />
          </div>
        </>
      )}
    </div>
  )
}

// ---- 分组 ----

function resolveByPromptGroups(
  details: readonly ByPromptDetailRow[],
  mode: GroupMode,
  marks: MarkMap,
): ByPromptModelRow[] {
  const byKey = new Map<string, ByPromptModelRow>()
  const idsPerKey = new Map<string, Set<string>>()

  for (const d of details) {
    const key = resolveGroupKey(d.primaryModelKey, mode, marks)
    let g = byKey.get(key)
    if (!g) {
      g = {
        groupKey: key,
        displayName: key,
        modelIds: [],
        merged: false,
        marked: false,
        recognized: false,
        promptCount: 0,
        calls: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        errorCount: 0,
        cost: 0,
        avgTokensPerPrompt: 0,
        avgCostPerPrompt: 0,
        avgCallsPerPrompt: 0,
      }
      byKey.set(key, g)
      idsPerKey.set(key, new Set())
    }
    const idSet = idsPerKey.get(key)!
    idSet.add(d.primaryModelKey)
    if (isMarkedModel(d.primaryModelKey)) g.marked = true
    if (isRecognizedModel(d.primaryModelKey)) g.recognized = true
    g.promptCount += 1
    g.calls += d.modelCalls
    g.totalTokens += d.totalTokens
    g.inputTokens += d.inputTokens
    g.outputTokens += d.outputTokens
    g.reasoningTokens += d.reasoningTokens
    g.cacheReadTokens += d.cacheReadTokens
    g.cacheCreationTokens += d.cacheCreationTokens
    g.errorCount += d.errorCount
    g.cost += d.cost
  }

  const out = [...byKey.values()]
  for (const g of out) {
    g.modelIds = [...(idsPerKey.get(g.groupKey) ?? new Set())]
    g.merged = g.modelIds.length > 1
    if (g.recognized) {
      const firstId = g.modelIds[0] ?? g.groupKey
      const builtin = applyBuiltin(firstId)
      let key: string
      if (builtin) {
        key = builtin
      } else {
        const m = resolveMatch(firstId)
        key = m.rule === 'default' ? g.groupKey : m.matched
      }
      g.displayName = displayNameOf(key)
    }
    g.avgTokensPerPrompt = g.promptCount > 0 ? g.totalTokens / g.promptCount : 0
    g.avgCostPerPrompt = g.promptCount > 0 ? g.cost / g.promptCount : 0
    g.avgCallsPerPrompt = g.promptCount > 0 ? g.calls / g.promptCount : 0
  }

  out.sort((a, b) => b.totalTokens - a.totalTokens)
  return out
}

// ---- KPI ----

type PromptKpis = {
  totalPrompts: number
  avgTokens: number
  avgCost: number
  avgCalls: number
}

function KpiGrid(props: { kpis?: PromptKpis | null; loading?: boolean }) {
  const { kpis, loading } = props
  return (
    <div class="kpi-grid kpi-grid--3">
      <KpiCard
        label="总 Prompt 数"
        tone="blue"
        loading={loading}
        value={kpis ? formatFull(kpis.totalPrompts) : ''}
        sub="所选时间范围内完整完成的 turn"
      />
      <KpiCard
        label="平均每次 Prompt 成本"
        tone="orange"
        loading={loading}
        value={kpis ? formatRMB(kpis.avgCost) : ''}
        sub="按内置价目表估算"
      />
      <KpiCard
        label="平均每次 Prompt Token"
        tone="purple"
        loading={loading}
        value={kpis ? formatCount(kpis.avgTokens, 2) : ''}
        sub="含输入 / 输出 / reasoning / 缓存"
      />
      <KpiCard
        label="平均每次 Prompt 调用"
        tone="default"
        loading={loading}
        value={kpis ? kpis.avgCalls.toFixed(2) : ''}
        sub="model_usage 调用次数"
      />
    </div>
  )
}

// ---- 表格列 ----

const modelColumns = [
  {
    key: 'model',
    header: '模型分组',
    width: '220px',
    render: (r: ByPromptModelRow) => {
      const tagged = r.marked
      return (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span
            style={{
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              flexWrap: 'wrap',
            }}
          >
            {r.displayName}
            {tagged ? (
              <span title="已标记：用户手动指定了计价模型" style={tagStyle('#1f6f43', '#d4f4e1')}>
                已标记
              </span>
            ) : r.recognized ? (
              <span title="价目表里能精确匹配到模型" style={tagStyle('#1f6f43', '#d4f4e1')}>
                已识别
              </span>
            ) : (
              <span title="未命中价目表，成本按 v4-pro 默认价估算" style={tagStyle('#fff', '#9aa0a6')}>
                未识别
              </span>
            )}
            {r.merged && (
              <span
                title={`该组合并了 ${r.modelIds.length} 个 model_id`}
                style={tagStyle('#fff', '#8e8e93')}
              >
                {r.modelIds.length} 个ID
              </span>
            )}
          </span>
          <span style={{ fontSize: 10, color: '#8a8a90' }} class="mono">
            {r.modelIds.join(' · ')}
          </span>
        </div>
      )
    },
  },
  {
    key: 'prompts',
    header: 'Prompt 数',
    align: 'right' as const,
    width: '90px',
    render: (r: ByPromptModelRow) => formatFull(r.promptCount),
  },
  {
    key: 'calls',
    header: '调用',
    align: 'right' as const,
    width: '80px',
    render: (r: ByPromptModelRow) => formatCount(r.calls),
  },
  {
    key: 'total',
    header: '总 token',
    align: 'right' as const,
    width: '95px',
    render: (r: ByPromptModelRow) => formatCount(r.totalTokens),
  },
  {
    key: 'avgTokens',
    header: '平均/Prompt token',
    align: 'right' as const,
    width: '120px',
    render: (r: ByPromptModelRow) => formatCount(r.avgTokensPerPrompt, 2),
  },
  {
    key: 'cost',
    header: '总成本',
    align: 'right' as const,
    width: '100px',
    render: (r: ByPromptModelRow) => formatRMB(r.cost),
  },
  {
    key: 'avgCost',
    header: '平均/Prompt 成本',
    align: 'right' as const,
    width: '120px',
    render: (r: ByPromptModelRow) => formatRMB(r.avgCostPerPrompt),
  },
  {
    key: 'avgCalls',
    header: '平均/Prompt 调用',
    align: 'right' as const,
    width: '110px',
    render: (r: ByPromptModelRow) => r.avgCallsPerPrompt.toFixed(2),
  },
  {
    key: 'errors',
    header: '错误',
    align: 'right' as const,
    width: '70px',
    render: (r: ByPromptModelRow) => (r.errorCount > 0 ? formatCount(r.errorCount) : '—'),
  },
]

function detailColumns(displayMap: Map<string, string>) {
  return [
    {
      key: 'turnId',
      header: 'turn_id',
      width: '220px',
      render: (r: ByPromptDetailRow) => (
        <span class="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
          {r.turnId}
        </span>
      ),
    },
    {
      key: 'model',
      header: '主模型',
      width: '160px',
      render: (r: ByPromptDetailRow) => (
        <span style={{ fontWeight: 600, fontSize: 12 }}>{displayMap.get(r.primaryModelKey) ?? r.primaryModelKey}</span>
      ),
    },
    {
      key: 'calls',
      header: '调用',
      align: 'right' as const,
      width: '70px',
      render: (r: ByPromptDetailRow) => formatCount(r.modelCalls),
    },
    {
      key: 'total',
      header: '总 token',
      align: 'right' as const,
      width: '90px',
      render: (r: ByPromptDetailRow) => formatCount(r.totalTokens),
    },
    {
      key: 'cost',
      header: '成本',
      align: 'right' as const,
      width: '95px',
      render: (r: ByPromptDetailRow) => formatRMB(r.cost),
    },
    {
      key: 'span',
      header: '跨度',
      align: 'right' as const,
      width: '90px',
      render: (r: ByPromptDetailRow) =>
        r.firstSeen && r.lastSeen ? formatDuration(r.lastSeen - r.firstSeen) : '—',
    },
    {
      key: 'firstSeen',
      header: '时间',
      align: 'right' as const,
      width: '110px',
      render: (r: ByPromptDetailRow) =>
        r.firstSeen ? new Date(r.firstSeen).toISOString().slice(0, 16).replace('T', ' ') : '—',
    },
  ]
}

function tagStyle(fg: string, bg: string): preact.JSX.CSSProperties {
  return {
    fontSize: 9,
    fontWeight: 700,
    color: fg,
    background: bg,
    borderRadius: 6,
    padding: '1px 5px',
    lineHeight: 1.4,
  }
}
