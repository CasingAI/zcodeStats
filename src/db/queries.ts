// All SQL strings used by the analytics pages, kept in one place so the worker
// can compile / verify them at startup and the page code stays declarative.
//
// Notes on the schema (from `~/.zcode/cli/db/db.sqlite`):
//   model_usage.started_at, completed_at: ms epoch
//   model_usage.status in ('running','completed','error','cancelled')
//   model_usage.input_tokens, output_tokens, reasoning_tokens,
//     cache_creation_input_tokens, cache_read_input_tokens: INTEGER NOT NULL
//   model_usage.computed_total_tokens: precomputed = input + output + cache_*
//     + reasoning; we use it for "use total"
//   turn_usage.turn_id: per turn
//   tool_usage.tool_name, duration_ms, output_bytes, status

import type {
  ByDayByModelRow,
  BySessionByModelRow,
  ByDayRow,
  ByHourGrid,
  ByModelRow,
  BySessionRow,
  ByToolRow,
  ErrorsOverview,
  OverviewKpis,
  SqlExecResult,
} from './types.ts'
import { costFor, type UsageForCost } from '../lib/pricing.ts'

// 参数化查询：sql 里带 ? 占位符，bind 为对应的绑定值（走 worker 的 bind）。
export type ParamQuery = { sql: string; bind?: unknown[] }

export type Range = '7d' | '30d' | 'all'

function rangeClause(range: Range): string {
  if (range === 'all') return ''
  const ms = (range === '7d' ? 7 : 30) * 86400 * 1000
  return `AND started_at >= ${Date.now() - ms}`
}

/** 追加 model_id IN (...) 谓词，并把绑定值推进 bind。 */
function modelIdClause(bind: unknown[], modelIds: readonly string[]): string {
  if (!modelIds || modelIds.length === 0) return ''
  const placeholders = modelIds.map(() => '?').join(', ')
  bind.push(...modelIds)
  return `AND model_id IN (${placeholders})`
}

export const QUERIES = {
  overview(range: '7d' | '30d' | 'all'): ParamQuery {
    const sql = `
      SELECT
        COALESCE(SUM(computed_total_tokens), 0)                                 AS totalTokens,
        COALESCE(SUM(input_tokens), 0)                                           AS inputTokens,
        COALESCE(SUM(output_tokens), 0)                                          AS outputTokens,
        COALESCE(SUM(reasoning_tokens), 0)                                      AS reasoningTokens,
        COALESCE(SUM(cache_read_input_tokens), 0)                                AS cacheReadTokens,
        COALESCE(SUM(cache_creation_input_tokens), 0)                            AS cacheCreationTokens,
        COUNT(*)                                                                 AS modelCallCount,
        SUM(CASE WHEN status='error' THEN 1 ELSE 0 END)                          AS modelErrorCount,
        SUM(CASE WHEN context_exceeded=1 THEN 1 ELSE 0 END)                      AS contextExceededCount,
        COALESCE(SUM(retry_count), 0)                                            AS retryTotal,
        MIN(started_at)                                                          AS firstSeen,
        MAX(started_at)                                                          AS lastSeen,
        COUNT(DISTINCT strftime('%Y-%m-%d', started_at/1000, 'unixepoch'))       AS activeDays
      FROM model_usage
      WHERE status='completed' ${rangeClause(range)}
    `
    return { sql }
  },

  /**
   * tool_usage 有 started_at INTEGER（ms epoch）— 与 model_usage 口径一致，
   * 所以走同一个 rangeClause。7d/30d 视图下"工具调用"也会跟着缩。
   */
  toolOverview(range: '7d' | '30d' | 'all'): ParamQuery {
    const sql = `
      SELECT
        COUNT(*)                                                AS toolCallCount,
        SUM(CASE WHEN status='error' THEN 1 ELSE 0 END)         AS toolErrorCount
      FROM tool_usage
      WHERE 1=1 ${rangeClause(range)}
    `
    return { sql }
  },

  /**
   * 按 model_id + provider_id 聚合。
   * 默认 LIMIT 5000：覆盖几乎所有用户；超过时 by-model 页 UI 会有"已截断"角标。
   * 接受 range（overview / by-model 用同一份 range 内 byModel 行算 cost）。
   * 注意：share 字段在 main thread 由 shapeByModel 重算（用全行总和），
   * SQL 里的 share 是占位，下游直接覆盖。
   */
  byModel(range: '7d' | '30d' | 'all'): ParamQuery {
    const sql = `
      WITH agg AS (
        SELECT
          model_id,
          COALESCE(provider_id, '?') AS provider_id,
          COUNT(*) AS calls,
          SUM(computed_total_tokens) AS totalTokens,
          SUM(input_tokens) AS inputTokens,
          SUM(output_tokens) AS outputTokens,
          SUM(reasoning_tokens) AS reasoningTokens,
          SUM(cache_read_input_tokens) AS cacheReadTokens,
          SUM(cache_creation_input_tokens) AS cacheCreationTokens,
          SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errorCount
        FROM model_usage
        WHERE status='completed' ${rangeClause(range)}
        GROUP BY model_id, provider_id
      ),
      total AS (SELECT SUM(totalTokens) AS s FROM agg)
      SELECT
        agg.model_id              AS modelId,
        agg.provider_id           AS providerId,
        agg.calls                 AS calls,
        agg.totalTokens           AS totalTokens,
        agg.inputTokens           AS inputTokens,
        agg.outputTokens          AS outputTokens,
        agg.reasoningTokens       AS reasoningTokens,
        agg.cacheReadTokens       AS cacheReadTokens,
        agg.cacheCreationTokens   AS cacheCreationTokens,
        agg.errorCount            AS errorCount,
        CASE WHEN (agg.inputTokens + agg.cacheCreationTokens) > 0
             THEN CAST(agg.cacheReadTokens AS REAL) / (agg.inputTokens + agg.cacheCreationTokens)
             ELSE 0 END          AS cacheHitRate,
        CASE WHEN total.s > 0
             THEN CAST(agg.totalTokens AS REAL) / total.s
             ELSE 0 END          AS share
      FROM agg, total
      ORDER BY totalTokens DESC
      LIMIT 5000
    `
    return { sql }
  },

  byDay(range: '7d' | '30d' | 'all', modelIds: readonly string[] = []): ParamQuery {
    const bind: unknown[] = []
    const sql = `
      SELECT
        strftime('%Y-%m-%d', started_at/1000, 'unixepoch') AS day,
        COUNT(*)                                            AS calls,
        SUM(computed_total_tokens)                          AS totalTokens,
        SUM(input_tokens)                                   AS inputTokens,
        SUM(output_tokens)                                  AS outputTokens,
        SUM(cache_read_input_tokens)                        AS cacheReadTokens,
        SUM(cache_creation_input_tokens)                    AS cacheCreationTokens,
        SUM(CASE WHEN status='error' THEN 1 ELSE 0 END)     AS errorCount,
        CASE WHEN SUM(input_tokens + cache_creation_input_tokens) > 0
             THEN CAST(SUM(cache_read_input_tokens) AS REAL) / SUM(input_tokens + cache_creation_input_tokens)
             ELSE 0 END                                     AS cacheHitRate,
        SUM(reasoning_tokens)                               AS reasoningTokens
      FROM model_usage
      WHERE status='completed' ${rangeClause(range)} ${modelIdClause(bind, modelIds)}
      GROUP BY day
      ORDER BY day ASC
    `
    return { sql, bind: bind.length > 0 ? bind : undefined }
  },

  bySession(range: '7d' | '30d' | 'all'): ParamQuery {
    const sql = `
      WITH s AS (
        SELECT
          session_id,
          COUNT(*)                       AS calls,
          SUM(computed_total_tokens)     AS totalTokens,
          SUM(input_tokens)              AS inputTokens,
          SUM(output_tokens)             AS outputTokens,
          SUM(cache_read_input_tokens)   AS cacheReadTokens,
          MIN(started_at)                AS firstSeen,
          MAX(started_at)                AS lastSeen
        FROM model_usage
        WHERE status='completed' AND session_id IS NOT NULL ${rangeClause(range)}
        GROUP BY session_id
      )
      SELECT
        s.session_id                                AS sessionId,
        sess.title                                  AS title,
        sess.directory                              AS directory,
        sess.task_type                              AS taskType,
        s.calls                                     AS calls,
        s.totalTokens                               AS totalTokens,
        s.inputTokens                               AS inputTokens,
        s.outputTokens                              AS outputTokens,
        s.cacheReadTokens                           AS cacheReadTokens,
        s.firstSeen                                 AS firstSeen,
        s.lastSeen                                  AS lastSeen
      FROM s
      LEFT JOIN session sess ON sess.id = s.session_id
      ORDER BY totalTokens DESC
      LIMIT 50
    `
    return { sql }
  },

  byHour(range: '7d' | '30d' | 'all', modelIds: readonly string[] = []): ParamQuery {
    const bind: unknown[] = []
    const sql = `
      SELECT
        CAST(strftime('%w', started_at/1000, 'unixepoch') AS INTEGER) AS weekday,
        CAST(strftime('%H', started_at/1000, 'unixepoch') AS INTEGER) AS hour,
        COUNT(*)                                                       AS calls,
        SUM(computed_total_tokens)                                     AS totalTokens
      FROM model_usage
      WHERE status='completed' ${rangeClause(range)} ${modelIdClause(bind, modelIds)}
      GROUP BY weekday, hour
    `
    return { sql, bind: bind.length > 0 ? bind : undefined }
  },

  /**
   * 按"日 × model_id"展开：每行 4 项分项 token，用于按日成本曲线。每行的
   * 4 个数值会在主线程按 model_id 单价加权成成本。
   */
  byDayByModel(range: '7d' | '30d' | 'all'): ParamQuery {
    const sql = `
      SELECT
        strftime('%Y-%m-%d', started_at/1000, 'unixepoch') AS day,
        model_id                                            AS modelId,
        SUM(input_tokens)                                   AS inputTokens,
        SUM(output_tokens)                                  AS outputTokens,
        SUM(reasoning_tokens)                               AS reasoningTokens,
        SUM(cache_read_input_tokens)                        AS cacheReadTokens,
        SUM(cache_creation_input_tokens)                    AS cacheCreationTokens
      FROM model_usage
      WHERE status='completed' ${rangeClause(range)}
      GROUP BY day, model_id
      ORDER BY day ASC
    `
    return { sql }
  },

  /**
   * 按 "session_id × model_id" 展开：每行 4 项分项 token，用于按会话成本列。
   * 主线程会按 model_id 单价加权求和。
   */
  bySessionByModel(range: '7d' | '30d' | 'all'): ParamQuery {
    const sql = `
      SELECT
        session_id                                          AS sessionId,
        model_id                                            AS modelId,
        SUM(input_tokens)                                   AS inputTokens,
        SUM(output_tokens)                                  AS outputTokens,
        SUM(reasoning_tokens)                               AS reasoningTokens,
        SUM(cache_read_input_tokens)                        AS cacheReadTokens,
        SUM(cache_creation_input_tokens)                    AS cacheCreationTokens
      FROM model_usage
      WHERE status='completed' AND session_id IS NOT NULL ${rangeClause(range)}
      GROUP BY session_id, model_id
    `
    return { sql }
  },

  byTool: `
    SELECT
      tool_name                                                       AS toolName,
      COUNT(*)                                                        AS calls,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END)                 AS errorCount,
      CASE WHEN COUNT(*) > 0
           THEN CAST(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS REAL) / COUNT(*)
           ELSE 0 END                                                 AS errorRate,
      AVG(duration_ms)                                                AS avgDurationMs,
      SUM(COALESCE(output_bytes, 0))                                  AS totalOutputBytes,
      AVG(COALESCE(output_bytes, 0))                                  AS avgOutputBytes
    FROM tool_usage
    GROUP BY tool_name
    ORDER BY calls DESC
    LIMIT 50
  `,

  errors: `
    WITH base AS (
      SELECT * FROM model_usage
    )
    SELECT
      COUNT(*) AS totalCalls,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errorCount,
      CASE WHEN COUNT(*) > 0
           THEN CAST(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS REAL) / COUNT(*)
           ELSE 0 END AS errorRate,
      SUM(CASE WHEN context_exceeded=1 THEN 1 ELSE 0 END) AS contextExceededCount,
      SUM(retry_count) AS retryCount,
      SUM(CASE WHEN cancelled_by_user=1 THEN 1 ELSE 0 END) AS cancelCount
    FROM base
  `,

  errorsByStatus: `
    SELECT status, COUNT(*) AS n
    FROM model_usage
    GROUP BY status
    ORDER BY n DESC
  `,

  errorsByErrorType: `
    SELECT error_type AS errorType, COUNT(*) AS n
    FROM model_usage
    WHERE error_type IS NOT NULL
    GROUP BY error_type
    ORDER BY n DESC
    LIMIT 20
  `,

  errorsByRetryCount: `
    SELECT retry_count AS retryCount, COUNT(*) AS n
    FROM model_usage
    GROUP BY retry_count
    ORDER BY retry_count ASC
  `,

  /**
   * 错误 / 上下文超限行的成本明细：每行 (model_id, 各分项 token)。
   * 主线程按 model_id 单价加权求和 = "错误 / 重试烧掉的钱"。
   */
  errorsByModel: `
    SELECT
      model_id                                            AS modelId,
      SUM(input_tokens)                                   AS inputTokens,
      SUM(output_tokens)                                  AS outputTokens,
      SUM(reasoning_tokens)                               AS reasoningTokens,
      SUM(cache_read_input_tokens)                        AS cacheReadTokens,
      SUM(cache_creation_input_tokens)                    AS cacheCreationTokens
    FROM model_usage
    WHERE status='error' OR context_exceeded=1 OR cancelled_by_user=1
    GROUP BY model_id
  `,
} as const

// Helpers used by the page code, not by SQL strings. They run queries through
// the worker and shape results into the right TypeScript types.

type WorkerExecResult = {
  columns: string[]
  rows: unknown[][]
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string') return Number(v) || 0
  return 0
}

function toNumberOrNull(v: unknown): number | null {
  if (v == null) return null
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string') return Number(v) || null
  return null
}

function toStringOrNull(v: unknown): string | null {
  if (v == null) return null
  return String(v)
}

export function shapeOverview(
  model: WorkerExecResult,
  tool: WorkerExecResult,
  /** 必须传入 byModel 的明细（带 per-id cost），用于填充 cost 字段 */
  byModelRows: readonly { modelId: string; cost: number }[],
): OverviewKpis {
  const m = model.rows[0] ?? []
  const t = tool.rows[0] ?? []
  const totalTokens = toNumber(m[0])
  const inputTokens = toNumber(m[1])
  const outputTokens = toNumber(m[2])
  const reasoningTokens = toNumber(m[3])
  const cacheReadTokens = toNumber(m[4])
  const cacheCreationTokens = toNumber(m[5])
  const cacheHitDenom = inputTokens + cacheCreationTokens
  const cacheHitRate = cacheHitDenom > 0 ? cacheReadTokens / cacheHitDenom : 0
  let cost = 0
  for (const r of byModelRows) cost += r.cost
  return {
    totalTokens,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheCreationTokens,
    modelCallCount: toNumber(m[6]),
    modelErrorCount: toNumber(m[7]),
    contextExceededCount: toNumber(m[8]),
    retryTotal: toNumber(m[9]),
    firstSeen: toNumberOrNull(m[10]),
    lastSeen: toNumberOrNull(m[11]),
    activeDays: toNumber(m[12]),
    toolCallCount: toNumber(t[0]),
    toolErrorCount: toNumber(t[1]),
    cacheHitRate,
    cost,
  }
}

export function shapeByModel(
  r: WorkerExecResult,
): ByModelRow[] {
  return r.rows.map((row) => {
    const inputTokens = toNumber(row[4])
    const outputTokens = toNumber(row[5])
    const reasoningTokens = toNumber(row[6])
    const cacheReadTokens = toNumber(row[7])
    const cacheCreationTokens = toNumber(row[8])
    // model_usage.model_id 是 TEXT NOT NULL；这里仍兜底成空串防止 SQLite 边界（GROUP BY 出现 NULL 仍会分组）。
    const modelId = String(row[0] ?? '')
    const usage: UsageForCost = {
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheCreationTokens,
    }
    return {
      modelId,
      providerId: String(row[1] ?? '?'),
      calls: toNumber(row[2]),
      totalTokens: toNumber(row[3]),
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheCreationTokens,
      errorCount: toNumber(row[9]),
      cacheHitRate: toNumber(row[10]),
      share: toNumber(row[11]),
      cost: costFor(modelId, usage),
    }
  })
}

export function shapeByDay(
  r: WorkerExecResult,
  /** 来自 byDayByModel 的成本按 day 折叠 */
  costByDay: ReadonlyMap<string, number>,
): ByDayRow[] {
  return r.rows.map((row) => ({
    day: String(row[0] ?? ''),
    calls: toNumber(row[1]),
    totalTokens: toNumber(row[2]),
    inputTokens: toNumber(row[3]),
    outputTokens: toNumber(row[4]),
    cacheReadTokens: toNumber(row[5]),
    cacheCreationTokens: toNumber(row[6]),
    errorCount: toNumber(row[7]),
    cacheHitRate: toNumber(row[8]),
    reasoningTokens: toNumber(row[9]),
    cost: costByDay.get(String(row[0] ?? '')) ?? 0,
  }))
}

export function shapeBySession(
  r: WorkerExecResult,
  costBySession: ReadonlyMap<string, number>,
): BySessionRow[] {
  return r.rows.map((row) => ({
    sessionId: String(row[0] ?? ''),
    title: toStringOrNull(row[1]),
    directory: toStringOrNull(row[2]),
    taskType: toStringOrNull(row[3]),
    calls: toNumber(row[4]),
    totalTokens: toNumber(row[5]),
    inputTokens: toNumber(row[6]),
    outputTokens: toNumber(row[7]),
    cacheReadTokens: toNumber(row[8]),
    firstSeen: toNumberOrNull(row[9]),
    lastSeen: toNumberOrNull(row[10]),
    cost: costBySession.get(String(row[0] ?? '')) ?? 0,
  }))
}

export function shapeByDayByModel(
  r: WorkerExecResult,
): ByDayByModelRow[] {
  return r.rows.map((row) => ({
    day: String(row[0] ?? ''),
    modelId: String(row[1] ?? ''),
    inputTokens: toNumber(row[2]),
    outputTokens: toNumber(row[3]),
    reasoningTokens: toNumber(row[4]),
    cacheReadTokens: toNumber(row[5]),
    cacheCreationTokens: toNumber(row[6]),
  }))
}

export function shapeBySessionByModel(
  r: WorkerExecResult,
): BySessionByModelRow[] {
  return r.rows.map((row) => ({
    sessionId: String(row[0] ?? ''),
    modelId: String(row[1] ?? ''),
    inputTokens: toNumber(row[2]),
    outputTokens: toNumber(row[3]),
    reasoningTokens: toNumber(row[4]),
    cacheReadTokens: toNumber(row[5]),
    cacheCreationTokens: toNumber(row[6]),
  }))
}

/** 给一组 ByDayByModelRow 按 day 折叠，得到 day → ¥。 */
export function aggregateCostByDay(
  rows: readonly ByDayByModelRow[],
): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) {
    if (!r.modelId) continue
    const c = costFor(
      r.modelId,
      {
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        reasoningTokens: r.reasoningTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheCreationTokens: r.cacheCreationTokens,
      },
    )
    m.set(r.day, (m.get(r.day) ?? 0) + c)
  }
  return m
}

/** 给一组 BySessionByModelRow 按 sessionId 折叠，得到 sessionId → ¥。 */
export function aggregateCostBySession(
  rows: readonly BySessionByModelRow[],
): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) {
    if (!r.modelId) continue
    const c = costFor(
      r.modelId,
      {
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        reasoningTokens: r.reasoningTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheCreationTokens: r.cacheCreationTokens,
      },
    )
    m.set(r.sessionId, (m.get(r.sessionId) ?? 0) + c)
  }
  return m
}

export function shapeByHour(r: WorkerExecResult): ByHourGrid {
  const cells = r.rows.map((row) => ({
    weekday: toNumber(row[0]),
    hour: toNumber(row[1]),
    calls: toNumber(row[2]),
    totalTokens: toNumber(row[3]),
  }))
  const maxTokens = cells.reduce((m, c) => (c.totalTokens > m ? c.totalTokens : m), 0)
  return { cells, maxTokens }
}

export function shapeByTool(r: WorkerExecResult): ByToolRow[] {
  return r.rows.map((row) => ({
    toolName: String(row[0] ?? '?'),
    calls: toNumber(row[1]),
    errorCount: toNumber(row[2]),
    errorRate: toNumber(row[3]),
    avgDurationMs: toNumberOrNull(row[4]),
    totalOutputBytes: toNumber(row[5]),
    avgOutputBytes: toNumber(row[6]),
  }))
}

export function shapeErrors(
  overview: WorkerExecResult,
  byStatus: WorkerExecResult,
  byErrorType: WorkerExecResult,
  byRetry: WorkerExecResult,
): ErrorsOverview {
  const o = overview.rows[0] ?? []
  return {
    totalCalls: toNumber(o[0]),
    errorCount: toNumber(o[1]),
    errorRate: toNumber(o[2]),
    contextExceededCount: toNumber(o[3]),
    retryCount: toNumber(o[4]),
    cancelCount: toNumber(o[5]),
    byStatus: byStatus.rows.map((row) => ({
      status: String(row[0] ?? ''),
      n: toNumber(row[1]),
    })),
    byErrorType: byErrorType.rows.map((row) => ({
      errorType: toStringOrNull(row[0]),
      n: toNumber(row[1]),
    })),
    retryDistribution: byRetry.rows.map((row) => ({
      retryCount: toNumber(row[0]),
      n: toNumber(row[1]),
    })),
  }
}

export type RawSqlResult = SqlExecResult
