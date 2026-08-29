import { DataTable } from '../ui/data-table.tsx'
import { RangeSelectorTabs, RangeSelectorPanelForBelow, useRangeSelectorState } from '../ui/range-selector.tsx'
import { useQuery } from '../lib/use-query.ts'
import {
  QUERIES,
  rangeSignature,
  shapeBySession,
  shapeBySessionByModel,
  aggregateCostBySession,
} from '../db/queries.ts'
import type { OpenedDb } from '../db/client.ts'
import type { BySessionRow } from '../db/types.ts'
import { useMarks, useCustomModels, marksSignature } from '../lib/model-groups.ts'
import { useRange } from '../lib/range-context.tsx'
import { formatCount, formatDuration, formatRMB } from '../lib/format.ts'

export function BySessionPage({ db }: { db: OpenedDb }) {
  const { range, setPreset, setCustom } = useRange()
  const rs = useRangeSelectorState({ value: range, onPreset: setPreset, onCustom: setCustom })
  const marks = useMarks()
  const custom = useCustomModels()
  const state = useQuery<BySessionRow[]>(
    db,
    `by-session:${rangeSignature(range)}:${marksSignature(marks, custom)}`,
    async (d) => {
      const [s, sbm] = await Promise.all([
        d.select(QUERIES.bySession(range).sql, QUERIES.bySession(range).bind),
        d.select(QUERIES.bySessionByModel(range).sql, QUERIES.bySessionByModel(range).bind),
      ])
      const costMap = aggregateCostBySession(shapeBySessionByModel(sbm))
      return shapeBySession(s, costMap)
    },
  )

  return (
    <div class="page">
      <div class="section__header">
        <div>
          <h1 class="page__title">按会话</h1>
          <p class="page__subtitle">总 token 用量 Top 50 session（按所选时间范围）</p>
        </div>
        <RangeSelectorTabs state={rs} ariaLabel="时间范围" />
      </div>

      <RangeSelectorPanelForBelow state={rs} />

      <div class="section">
        {state.kind === 'loading' && <DataTable columns={columns} rows={[]} rowKey={() => ''} loading />}
        {state.kind === 'error' && <div class="app-banner app-banner--error">{state.error}</div>}
        {state.kind === 'ok' && (
          <DataTable
            columns={columns}
            rows={state.data}
            rowKey={(r) => r.sessionId}
            emptyMessage="没有数据"
          />
        )}
      </div>
    </div>
  )
}

const columns = [
  {
    key: 'title',
    header: '会话',
    width: '260px',
    render: (r: BySessionRow) => (
      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {r.title ?? '—'}
        </span>
        <span style={{ fontSize: 10, color: '#8a8a90' }}>
          {r.taskType ?? '?'} · {r.directory ? r.directory.split('/').slice(-2).join('/') : ''}
        </span>
      </div>
    ),
  },
  {
    key: 'calls',
    header: '调用',
    align: 'right' as const,
    width: '80px',
    render: (r: BySessionRow) => formatCount(r.calls),
  },
  {
    key: 'total',
    header: '总 token',
    align: 'right' as const,
    render: (r: BySessionRow) => formatCount(r.totalTokens),
  },
  {
    key: 'in',
    header: '输入',
    align: 'right' as const,
    render: (r: BySessionRow) => formatCount(r.inputTokens),
  },
  {
    key: 'cache',
    header: '缓存读',
    align: 'right' as const,
    render: (r: BySessionRow) => formatCount(r.cacheReadTokens),
  },
  {
    key: 'out',
    header: '输出',
    align: 'right' as const,
    render: (r: BySessionRow) => formatCount(r.outputTokens),
  },
  {
    key: 'cost',
    header: '大致成本',
    align: 'right' as const,
    width: '110px',
    render: (r: BySessionRow) => formatRMB(r.cost),
  },
  {
    key: 'span',
    header: '跨度',
    align: 'right' as const,
    width: '90px',
    render: (r: BySessionRow) =>
      r.firstSeen && r.lastSeen ? formatDuration(r.lastSeen - r.firstSeen) : '—',
  },
]
