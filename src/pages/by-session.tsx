import { useState } from 'preact/hooks'
import { DataTable } from '../ui/data-table.tsx'
import { SegmentedControl } from '../ui/segmented-control.tsx'
import { useQuery } from '../lib/use-query.ts'
import {
  QUERIES,
  shapeBySession,
  shapeBySessionByModel,
  aggregateCostBySession,
  type Range,
} from '../db/queries.ts'
import type { OpenedDb } from '../db/client.ts'
import type { BySessionRow } from '../db/types.ts'
import { useMarks, useCustomModels, marksSignature } from '../lib/model-groups.ts'
import { formatCount, formatDuration, formatRMB } from '../lib/format.ts'

export function BySessionPage({ db }: { db: OpenedDb }) {
  const [range, setRange] = useState<Range>('all')
  const marks = useMarks()
  const custom = useCustomModels()
  const state = useQuery<BySessionRow[]>(
    db,
    `by-session:${range}:${marksSignature(marks, custom)}`,
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
