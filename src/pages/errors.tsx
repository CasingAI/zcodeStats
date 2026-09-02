import { KpiCard } from '../ui/kpi-card.tsx'
import { DataTable } from '../ui/data-table.tsx'
import { useQuery } from '../lib/use-query.ts'
import { QUERIES, shapeErrors } from '../db/queries.ts'
import type { OpenedDb } from '../db/client.ts'
import type { ErrorsOverview } from '../db/types.ts'
import { marksSignature, useMarks, useCustomModels } from '../lib/model-groups.ts'
import { costFor } from '../lib/pricing.ts'
import { formatCount, formatFull, formatPct, formatRMB } from '../lib/format.ts'

export function ErrorsPage({ db }: { db: OpenedDb }) {
  const marks = useMarks()
  const custom = useCustomModels()
  const state = useQuery<ErrorsOverview & { cost: number }>(
    db,
    `errors:${marksSignature(marks, custom)}`,
    async (d) => {
      const [overview, byStatus, byErrorType, byRetry, byModel] = await Promise.all([
        d.select(QUERIES.errors),
        d.select(QUERIES.errorsByStatus),
        d.select(QUERIES.errorsByErrorType),
        d.select(QUERIES.errorsByRetryCount),
        d.select(QUERIES.errorsByModel),
      ])
      const base = shapeErrors(overview, byStatus, byErrorType, byRetry)
      let cost = 0
      for (const r of byModel.rows) {
        const id = String(r[0] ?? '')
        if (!id) continue
        cost += costFor(id, {
          inputTokens: toNum(r[1]),
          outputTokens: toNum(r[2]),
          reasoningTokens: toNum(r[3]),
          cacheReadTokens: toNum(r[4]),
          cacheCreationTokens: toNum(r[5]),
        })
      }
      return { ...base, cost }
    },
  )

  // marks / custom 在 useQuery 之外不再消费；signature 已在 key 里

  if (state.kind === 'loading') {
    return (
      <div class="page">
        <h1 class="page__title">错误与重试</h1>
        <KpiGrid loading />
      </div>
    )
  }
  if (state.kind === 'error') {
    return (
      <div class="page">
        <h1 class="page__title">错误与重试</h1>
        <div class="app-banner app-banner--error">{state.error}</div>
      </div>
    )
  }
  const k = state.data
  return (
    <div class="page">
      <h1 class="page__title">错误与重试</h1>
      <p class="page__subtitle">所有 model_usage 记录的错误/重试/取消情况</p>
      <KpiGrid data={k} />

      <div class="section">
        <h2 class="section__title">按 status 分布</h2>
        <DataTable
          columns={[
            { key: 's', header: 'status', render: (r: { status: string; n: number }) => r.status },
            {
              key: 'n',
              header: '次数',
              align: 'right',
              render: (r: { status: string; n: number }) => formatFull(r.n),
            },
            {
              key: 'p',
              header: '占比',
              align: 'right',
              render: (r: { status: string; n: number }) =>
                formatPct(k.totalCalls > 0 ? r.n / k.totalCalls : 0),
            },
          ]}
          rows={k.byStatus}
          rowKey={(r) => r.status}
        />
      </div>

      {k.byErrorType.length > 0 && (
        <div class="section">
          <h2 class="section__title">按 error_type 分布</h2>
          <DataTable
            columns={[
              {
                key: 'e',
                header: 'error_type',
                render: (r: { errorType: string | null; n: number }) => r.errorType ?? '—',
              },
              {
                key: 'n',
                header: '次数',
                align: 'right',
                render: (r: { errorType: string | null; n: number }) => formatFull(r.n),
              },
            ]}
            rows={k.byErrorType}
            rowKey={(r) => r.errorType ?? 'null'}
          />
        </div>
      )}

      <div class="section">
        <h2 class="section__title">按 retry_count 分布</h2>
        <DataTable
          columns={[
            {
              key: 'r',
              header: '重试次数',
              align: 'right',
              render: (r: { retryCount: number; n: number }) => String(r.retryCount),
            },
            {
              key: 'n',
              header: '行数',
              align: 'right',
              render: (r: { retryCount: number; n: number }) => formatCount(r.n),
            },
          ]}
          rows={k.retryDistribution}
          rowKey={(r) => r.retryCount}
        />
      </div>
    </div>
  )
}

function KpiGrid(props: { data?: (ErrorsOverview & { cost: number }); loading?: boolean }) {
  const { data, loading } = props
  return (
    <div class="kpi-grid">
      <KpiCard
        label="错误率"
        tone={data && data.errorRate > 0.05 ? 'red' : 'default'}
        loading={loading}
        value={data ? formatPct(data.errorRate) : ''}
        sub={data ? `错误 ${data.errorCount} / 总 ${data.totalCalls}` : ''}
      />
      <KpiCard
        label="context_exceeded"
        tone="orange"
        loading={loading}
        value={data ? formatFull(data.contextExceededCount) : ''}
        sub="上下文超限（多半是 prompt cache 失败）"
      />
      <KpiCard
        label="重试累计"
        tone="orange"
        loading={loading}
        value={data ? formatFull(data.retryCount) : ''}
        sub="总重试次数"
      />
      <KpiCard
        label="用户取消"
        tone="default"
        loading={loading}
        value={data ? formatFull(data.cancelCount) : ''}
        sub="cancelled_by_user"
      />
      <KpiCard
        label="错误 / 重试烧掉的钱"
        tone="red"
        loading={loading}
        value={data ? formatRMB(data.cost) : ''}
        sub="status=error / context_exceeded / cancelled / retry_count>0 行的成本合计"
      />
    </div>
  )
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string') return Number(v) || 0
  return 0
}
