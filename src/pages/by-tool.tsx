import { DataTable } from '../ui/data-table.tsx'
import { useQuery } from '../lib/use-query.ts'
import { QUERIES, shapeByTool } from '../db/queries.ts'
import type { OpenedDb } from '../db/client.ts'
import type { ByToolRow } from '../db/types.ts'
import { formatBytes, formatCount, formatDuration, formatPct } from '../lib/format.ts'

export function ByToolPage({ db }: { db: OpenedDb }) {
  const state = useQuery<ByToolRow[]>(db, 'by-tool', async (d) => {
    const r = await d.select(QUERIES.byTool)
    return shapeByTool(r)
  })
  return (
    <div class="page">
      <h1 class="page__title">按工具</h1>
      <p class="page__subtitle">工具调用量、错误率、输出体积</p>
      <div class="section">
        {state.kind === 'loading' && <DataTable columns={columns} rows={[]} rowKey={() => ''} loading />}
        {state.kind === 'error' && <div class="app-banner app-banner--error">{state.error}</div>}
        {state.kind === 'ok' && (
          <DataTable
            columns={columns}
            rows={state.data}
            rowKey={(r) => r.toolName}
            emptyMessage="没有数据"
          />
        )}
      </div>
    </div>
  )
}

const columns = [
  { key: 'name', header: '工具', width: '160px', render: (r: ByToolRow) => r.toolName },
  {
    key: 'calls',
    header: '调用',
    align: 'right' as const,
    width: '90px',
    render: (r: ByToolRow) => formatCount(r.calls),
  },
  {
    key: 'err',
    header: '错误',
    align: 'right' as const,
    width: '70px',
    render: (r: ByToolRow) => formatCount(r.errorCount),
  },
  {
    key: 'errRate',
    header: '错误率',
    align: 'right' as const,
    width: '90px',
    render: (r: ByToolRow) => (
      <span style={{ color: r.errorRate > 0.1 ? '#b53024' : undefined }}>{formatPct(r.errorRate, 1)}</span>
    ),
  },
  {
    key: 'avgDur',
    header: '平均时长',
    align: 'right' as const,
    width: '100px',
    render: (r: ByToolRow) => (r.avgDurationMs != null ? formatDuration(r.avgDurationMs) : '—'),
  },
  {
    key: 'totalBytes',
    header: '输出总字节',
    align: 'right' as const,
    render: (r: ByToolRow) => formatBytes(r.totalOutputBytes),
  },
  {
    key: 'avgBytes',
    header: '平均输出字节',
    align: 'right' as const,
    render: (r: ByToolRow) => formatBytes(r.avgOutputBytes),
  },
]
