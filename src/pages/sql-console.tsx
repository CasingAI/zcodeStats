import { useState } from 'preact/hooks'
import { IosButton } from '../ui/ios-button.tsx'
import { DataTable } from '../ui/data-table.tsx'
import { runSql } from '../db/client.ts'
import type { OpenedDb } from '../db/client.ts'
import type { SqlExecResult } from '../db/types.ts'
import { formatFull } from '../lib/format.ts'

const STORAGE_KEY = 'zcode-stats.sql.last'

const PRESETS: { label: string; sql: string }[] = [
  {
    label: 'schema',
    sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  },
  {
    label: 'turns by status',
    sql: 'SELECT status, COUNT(*) AS n FROM turn_usage GROUP BY status',
  },
  {
    label: 'todos top',
    sql: "SELECT content, status, priority FROM todo WHERE status != 'completed' ORDER BY priority, position LIMIT 50",
  },
  {
    label: 'recent sessions',
    sql: "SELECT id, title, time_created FROM session ORDER BY time_created DESC LIMIT 20",
  },
]

export function SqlConsolePage({ db }: { db: OpenedDb }) {
  const [sql, setSql] = useState<string>(() => localStorage.getItem(STORAGE_KEY) ?? PRESETS[0]!.sql)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<SqlExecResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const onRun = async (override?: string) => {
    const finalSql = override ?? sql
    setSql(finalSql)
    localStorage.setItem(STORAGE_KEY, finalSql)
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const r = await runSql(db, finalSql)
      setResult(r)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div class="page">
      <h1 class="page__title">SQL 控制台</h1>
      <p class="page__subtitle">直接对当前 db 跑只读 SQL；schema 可点击预设填入</p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {PRESETS.map((p) => (
          <IosButton key={p.label} size="compact" onClick={() => onRun(p.sql)}>
            {p.label}
          </IosButton>
        ))}
      </div>

      <textarea
        value={sql}
        onInput={(e) => setSql((e.target as HTMLTextAreaElement).value)}
        rows={6}
        spellcheck={false}
        style={{
          width: '100%',
          padding: 8,
          border: '1px solid #a8a8a8',
          borderRadius: 4,
          font: '12px/1.4 "SF Mono", Menlo, monospace',
          background: '#fff',
          boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.08)',
          outline: 'none',
          resize: 'vertical',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <IosButton tone="primary" onClick={() => onRun()} disabled={running}>
          {running ? '执行中…' : '执行'}
        </IosButton>
        {result && (
          <span class="muted" style={{ fontSize: 11 }}>
            {result.rows.length} 行 · {result.durationMs}ms
          </span>
        )}
        {error && <span class="error-text" style={{ fontSize: 12 }}>{error}</span>}
      </div>

      {result && result.rows.length > 0 && (
        <RawResultTable result={result} />
      )}
      {result && result.rows.length === 0 && !error && (
        <div class="app-banner" style={{ marginTop: 12 }}>查询成功，0 行结果</div>
      )}
    </div>
  )
}

function RawResultTable({ result }: { result: SqlExecResult }) {
  return (
    <div class="section" style={{ marginTop: 8 }}>
      <DataTable
        columns={result.columns.map((c) => ({
          key: c,
          header: c,
          render: (_row: unknown[], i: number) => {
            const row = result.rows[i]
            const v = row ? row[result.columns.indexOf(c)] : null
            if (v == null) return <span class="muted">NULL</span>
            if (typeof v === 'number' || typeof v === 'bigint') {
              return <span class="mono">{formatFull(Number(v))}</span>
            }
            return <span class="mono" style={{ wordBreak: 'break-all' }}>{String(v)}</span>
          },
        }))}
        rows={result.rows}
        rowKey={(_r, i) => i}
        emptyMessage="没有数据"
      />
    </div>
  )
}
