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
  ByPromptByModelRow,
  ByPromptDetailRow,
  ByPromptSummaryRow,
  BySessionByModelRow,
  ByDayRow,
  ByHourGrid,
  ByModelRow,
  ByProviderModelRow,
  ByProviderRow,
  BySessionRow,
  ByToolRow,
  ErrorsOverview,
  OverviewKpis,
  SpeedSampleRow,
  SpeedTrendRow,
  SqlExecResult,
  TimingAggregates,
} from './types.ts'
import { costFor, type UsageForCost } from '../lib/pricing.ts'

// 参数化查询：sql 里带 ? 占位符，bind 为对应的绑定值（走 worker 的 bind）。
export type ParamQuery = { sql: string; bind?: unknown[] }

export type RangePreset = '7d' | '30d' | 'all'

export type Range =
  | { kind: 'preset'; preset: RangePreset }
  | { kind: 'custom'; from: number; to: number }

export const DEFAULT_RANGE: Range = { kind: 'preset', preset: '30d' }

/** 给 useQuery 当 key 用的稳定字符串。避免每次 render 都生成新 key。 */
export function rangeSignature(range: Range): string {
  if (range.kind === 'preset') return `p:${range.preset}`
  return `c:${range.from}:${range.to}`
}

function rangeClause(range: Range): string {
  if (range.kind === 'custom') {
    return `AND started_at >= ${range.from} AND started_at < ${range.to}`
  }
  if (range.preset === 'all') return ''
  const ms = (range.preset === '7d' ? 7 : 30) * 86400 * 1000
  return `AND started_at >= ${Date.now() - ms}`
}

/** 将 UTC epoch ms 偏移到本地时区 epoch ms 的毫秒数。
 *  用于 strftime('%H'/'%w') 取本地小时/星期。东八区 getTimezoneOffset=-480，返回 -28_800_000，
 *  SQL 中用 (started_at - offsetMs)/1000 即可得到本地时间。
 */
function timezoneOffsetMs(): number {
  return new Date().getTimezoneOffset() * 60 * 1000
}

/** 追加 model_id IN (...) 谓词，并把绑定值推进 bind。 */
function modelIdClause(bind: unknown[], modelIds: readonly string[]): string {
  if (!modelIds || modelIds.length === 0) return ''
  const placeholders = modelIds.map(() => '?').join(', ')
  bind.push(...modelIds)
  return `AND model_id IN (${placeholders})`
}

/**
 * 纯解码口径的速度样本谓词：输出速度不含「等首个 token」的时间，
 * 分母用 duration_ms - time_to_first_token_ms。TTFT 须有效（非空、>=0、< 总时长）
 * 才能参与；speedOutputTokens / speedDurationMs / speedSampleCount 三处
 * 必须使用同一谓词，保证分子分母覆盖同一批行。
 * 速度 = Σoutput_tokens / Σ(duration_ms - ttft) × 1000。
 */
const SPEED_VALID =
  'duration_ms > 0 AND output_tokens > 0 AND time_to_first_token_ms IS NOT NULL ' +
  'AND time_to_first_token_ms >= 0 AND time_to_first_token_ms < duration_ms'

/**
 * 速度页专用样本口径：在 SPEED_VALID 之上仅保留正常生成请求。
 * query_source 白名单实测：极值失真（解码窗口 9~36ms 上万 tok/s）全部来自
 * main_turn / subagent 的短窗口调用；compact / session_title 等辅助请求
 * 虽非失真来源，但它们不是「生成」行为，同样不计入速度页。
 */
const SPEED_SAMPLE =
  `(${SPEED_VALID}) AND query_source IN ('main_turn', 'subagent')`

/**
 * 速度页极值（最大/最小）口径：在 SPEED_SAMPLE 之上要求解码窗口 ≥3s
 * 且输出 ≥32 token，剔除短窗口计时噪声（假快）与流中途卡顿（假慢）。
 * 实测近 7 天 max 19,631 → 429 tok/s；仅用于 speedTrend 的 MAX/MIN 两列。
 */
const SPEED_EXTREME =
  `(${SPEED_SAMPLE}) AND duration_ms - time_to_first_token_ms >= 3000 AND output_tokens >= 32`

export const QUERIES = {
  overview(range: Range): ParamQuery {
    const tzOffsetMs = timezoneOffsetMs()
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
        SUM(CASE WHEN cancelled_by_user=1 THEN 1 ELSE 0 END)                     AS cancelCount,
        COALESCE(SUM(retry_count), 0)                                            AS retryTotal,
        MIN(started_at)                                                          AS firstSeen,
        MAX(started_at)                                                          AS lastSeen,
        COUNT(DISTINCT strftime('%Y-%m-%d', (started_at - ${tzOffsetMs})/1000, 'unixepoch'))       AS activeDays,
        SUM(CASE WHEN status='completed' AND duration_ms > 0 THEN duration_ms ELSE 0 END)            AS totalDurationMs,
        SUM(CASE WHEN status='completed' AND duration_ms > 0 THEN 1 ELSE 0 END)                       AS durationSampleCount,
        SUM(CASE WHEN status='completed' AND ${SPEED_VALID} THEN 1 ELSE 0 END) AS speedSampleCount,
        SUM(CASE WHEN status='completed' AND ${SPEED_VALID} THEN output_tokens ELSE 0 END) AS speedOutputTokens,
        SUM(CASE WHEN status='completed' AND ${SPEED_VALID} THEN duration_ms - time_to_first_token_ms ELSE 0 END)    AS speedDurationMs,
        SUM(CASE WHEN status='completed' AND time_to_first_token_ms IS NOT NULL THEN time_to_first_token_ms ELSE 0 END) AS ttftSumMs,
        SUM(CASE WHEN status='completed' AND time_to_first_token_ms IS NOT NULL THEN 1 ELSE 0 END)  AS ttftSampleCount
      FROM model_usage
      WHERE 1=1 ${rangeClause(range)}
    `
    return { sql }
  },

  /**
   * tool_usage 有 started_at INTEGER（ms epoch）— 与 model_usage 口径一致，
   * 所以走同一个 rangeClause。7d/30d 视图下"工具调用"也会跟着缩。
   */
  toolOverview(range: Range): ParamQuery {
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
  byModel(range: Range): ParamQuery {
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
          SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errorCount,
          SUM(CASE WHEN duration_ms > 0 THEN duration_ms ELSE 0 END) AS totalDurationMs,
          SUM(CASE WHEN duration_ms > 0 THEN 1 ELSE 0 END) AS durationSampleCount,
          SUM(CASE WHEN ${SPEED_VALID} THEN 1 ELSE 0 END) AS speedSampleCount,
          SUM(CASE WHEN ${SPEED_VALID} THEN output_tokens ELSE 0 END) AS speedOutputTokens,
          SUM(CASE WHEN ${SPEED_VALID} THEN duration_ms - time_to_first_token_ms ELSE 0 END) AS speedDurationMs,
          SUM(CASE WHEN time_to_first_token_ms IS NOT NULL THEN time_to_first_token_ms ELSE 0 END) AS ttftSumMs,
          SUM(CASE WHEN time_to_first_token_ms IS NOT NULL THEN 1 ELSE 0 END) AS ttftSampleCount
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
             ELSE 0 END          AS share,
        agg.totalDurationMs       AS totalDurationMs,
        agg.durationSampleCount   AS durationSampleCount,
        agg.speedSampleCount      AS speedSampleCount,
        agg.speedOutputTokens     AS speedOutputTokens,
        agg.speedDurationMs       AS speedDurationMs,
        agg.ttftSumMs             AS ttftSumMs,
        agg.ttftSampleCount       AS ttftSampleCount
      FROM agg, total
      ORDER BY totalTokens DESC
      LIMIT 5000
    `
    return { sql }
  },

  byDay(range: Range, modelIds: readonly string[] = []): ParamQuery {
    const bind: unknown[] = []
    const tzOffsetMs = timezoneOffsetMs()
    const sql = `
      SELECT
        strftime('%Y-%m-%d', (started_at - ${tzOffsetMs})/1000, 'unixepoch') AS day,
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
        SUM(reasoning_tokens)                               AS reasoningTokens,
        SUM(CASE WHEN duration_ms > 0 THEN duration_ms ELSE 0 END) AS totalDurationMs,
        SUM(CASE WHEN duration_ms > 0 THEN 1 ELSE 0 END) AS durationSampleCount,
        SUM(CASE WHEN ${SPEED_VALID} THEN 1 ELSE 0 END) AS speedSampleCount,
        SUM(CASE WHEN ${SPEED_VALID} THEN output_tokens ELSE 0 END) AS speedOutputTokens,
        SUM(CASE WHEN ${SPEED_VALID} THEN duration_ms - time_to_first_token_ms ELSE 0 END) AS speedDurationMs,
        SUM(CASE WHEN time_to_first_token_ms IS NOT NULL AND time_to_first_token_ms >= 0 THEN time_to_first_token_ms ELSE 0 END) AS ttftSumMs,
        SUM(CASE WHEN time_to_first_token_ms IS NOT NULL AND time_to_first_token_ms >= 0 THEN 1 ELSE 0 END) AS ttftSampleCount
      FROM model_usage
      WHERE status='completed' ${rangeClause(range)} ${modelIdClause(bind, modelIds)}
      GROUP BY day
      ORDER BY day ASC
    `
    return { sql, bind: bind.length > 0 ? bind : undefined }
  },

  bySession(range: Range): ParamQuery {
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

  byHour(range: Range, modelIds: readonly string[] = []): ParamQuery {
    const bind: unknown[] = []
    const tzOffsetMs = timezoneOffsetMs()
    const sql = `
      SELECT
        CAST(strftime('%w', (started_at - ${tzOffsetMs})/1000, 'unixepoch') AS INTEGER) AS weekday,
        CAST(strftime('%H', (started_at - ${tzOffsetMs})/1000, 'unixepoch') AS INTEGER) AS hour,
        COUNT(*)                                                       AS calls,
        SUM(computed_total_tokens)                                     AS totalTokens,
        SUM(CASE WHEN duration_ms > 0 THEN duration_ms ELSE 0 END)       AS totalDurationMs,
        SUM(CASE WHEN duration_ms > 0 THEN 1 ELSE 0 END)                AS durationSampleCount,
        SUM(CASE WHEN ${SPEED_VALID} THEN 1 ELSE 0 END) AS speedSampleCount,
        SUM(CASE WHEN ${SPEED_VALID} THEN output_tokens ELSE 0 END) AS speedOutputTokens,
        SUM(CASE WHEN ${SPEED_VALID} THEN duration_ms - time_to_first_token_ms ELSE 0 END) AS speedDurationMs,
        SUM(CASE WHEN time_to_first_token_ms IS NOT NULL AND time_to_first_token_ms >= 0 THEN time_to_first_token_ms ELSE 0 END) AS ttftSumMs,
        SUM(CASE WHEN time_to_first_token_ms IS NOT NULL AND time_to_first_token_ms >= 0 THEN 1 ELSE 0 END) AS ttftSampleCount
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
  byDayByModel(range: Range): ParamQuery {
    const tzOffsetMs = timezoneOffsetMs()
    const sql = `
      SELECT
        strftime('%Y-%m-%d', (started_at - ${tzOffsetMs})/1000, 'unixepoch') AS day,
        model_id                                            AS modelId,
        SUM(input_tokens)                                   AS inputTokens,
        SUM(output_tokens)                                  AS outputTokens,
        SUM(reasoning_tokens)                               AS reasoningTokens,
        SUM(cache_read_input_tokens)                        AS cacheReadTokens,
        SUM(cache_creation_input_tokens)                    AS cacheCreationTokens,
        SUM(CASE WHEN duration_ms > 0 THEN duration_ms ELSE 0 END) AS totalDurationMs,
        SUM(CASE WHEN duration_ms > 0 THEN 1 ELSE 0 END) AS durationSampleCount,
        SUM(CASE WHEN ${SPEED_VALID} THEN 1 ELSE 0 END) AS speedSampleCount,
        SUM(CASE WHEN ${SPEED_VALID} THEN output_tokens ELSE 0 END) AS speedOutputTokens,
        SUM(CASE WHEN ${SPEED_VALID} THEN duration_ms - time_to_first_token_ms ELSE 0 END) AS speedDurationMs,
        SUM(CASE WHEN time_to_first_token_ms IS NOT NULL AND time_to_first_token_ms >= 0 THEN time_to_first_token_ms ELSE 0 END) AS ttftSumMs,
        SUM(CASE WHEN time_to_first_token_ms IS NOT NULL AND time_to_first_token_ms >= 0 THEN 1 ELSE 0 END) AS ttftSampleCount
      FROM model_usage
      WHERE status='completed' ${rangeClause(range)}
      GROUP BY day, model_id
      ORDER BY day ASC
    `
    return { sql }
  },

  /**
   * 速度趋势：按「本地小时桶 × model_id」聚合速度样本（见 SPEED_SAMPLE/SPEED_EXTREME）。
   * 日/周粒度由页面在前端折叠小时桶得到，一条查询服务三种粒度。
   * 速度三列用 SPEED_SAMPLE（仅正常生成请求）；speedMax/speedMin 是桶内单次
   * 调用速度的极值，用 SPEED_EXTREME（解码 ≥3s 且输出 ≥32 token）。
   * ttftSumMs/ttftSampleCount 给页面的「平均首字等待」KPI 用。
   */
  speedTrend(range: Range): ParamQuery {
    const tzOffsetMs = timezoneOffsetMs()
    const sql = `
      SELECT
        strftime('%Y-%m-%dT%H', (started_at - ${tzOffsetMs})/1000, 'unixepoch') AS bucket,
        model_id                                            AS modelId,
        SUM(CASE WHEN ${SPEED_SAMPLE} THEN output_tokens ELSE 0 END) AS speedOutputTokens,
        SUM(CASE WHEN ${SPEED_SAMPLE} THEN duration_ms - time_to_first_token_ms ELSE 0 END) AS speedDurationMs,
        SUM(CASE WHEN ${SPEED_SAMPLE} THEN 1 ELSE 0 END) AS speedSampleCount,
        SUM(CASE WHEN time_to_first_token_ms IS NOT NULL AND time_to_first_token_ms >= 0 THEN time_to_first_token_ms ELSE 0 END) AS ttftSumMs,
        SUM(CASE WHEN time_to_first_token_ms IS NOT NULL AND time_to_first_token_ms >= 0 THEN 1 ELSE 0 END) AS ttftSampleCount,
        MAX(CASE WHEN ${SPEED_EXTREME} THEN output_tokens * 1000.0 / (duration_ms - time_to_first_token_ms) END) AS speedMaxTokPerS,
        MIN(CASE WHEN ${SPEED_EXTREME} THEN output_tokens * 1000.0 / (duration_ms - time_to_first_token_ms) END) AS speedMinTokPerS
      FROM model_usage
      WHERE status='completed' ${rangeClause(range)}
      GROUP BY bucket, model_id
      ORDER BY bucket ASC
    `
    return { sql }
  },

  /**
   * 速度页「中位数」口径的数据源：单次调用速度明细（本地小时桶 × model_id）。
   * 中位数无法像 SUM/MAX/MIN 那样跨桶合并，所以把明细交给前端按目标粒度折叠后计算。
   * 口径同 SPEED_SAMPLE（仅正常生成请求）。
   */
  speedTrendSamples(range: Range): ParamQuery {
    const tzOffsetMs = timezoneOffsetMs()
    const sql = `
      SELECT
        strftime('%Y-%m-%dT%H', (started_at - ${tzOffsetMs})/1000, 'unixepoch') AS bucket,
        model_id                                            AS modelId,
        output_tokens * 1000.0 / (duration_ms - time_to_first_token_ms) AS speedTokPerS
      FROM model_usage
      WHERE status='completed' AND ${SPEED_SAMPLE} ${rangeClause(range)}
      ORDER BY bucket ASC
    `
    return { sql }
  },

  /**
   * 按 provider_id 聚合：用于「按供应商」页。
   */
  byProvider(range: Range): ParamQuery {
    const sql = `
      WITH agg AS (
        SELECT
          COALESCE(provider_id, '?') AS provider_id,
          COUNT(*) AS calls,
          SUM(computed_total_tokens) AS totalTokens,
          SUM(input_tokens) AS inputTokens,
          SUM(output_tokens) AS outputTokens,
          SUM(reasoning_tokens) AS reasoningTokens,
          SUM(cache_read_input_tokens) AS cacheReadTokens,
          SUM(cache_creation_input_tokens) AS cacheCreationTokens,
          SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errorCount,
          SUM(CASE WHEN duration_ms > 0 THEN duration_ms ELSE 0 END) AS totalDurationMs,
          SUM(CASE WHEN duration_ms > 0 THEN 1 ELSE 0 END) AS durationSampleCount,
          SUM(CASE WHEN ${SPEED_VALID} THEN 1 ELSE 0 END) AS speedSampleCount,
          SUM(CASE WHEN ${SPEED_VALID} THEN output_tokens ELSE 0 END) AS speedOutputTokens,
          SUM(CASE WHEN ${SPEED_VALID} THEN duration_ms - time_to_first_token_ms ELSE 0 END) AS speedDurationMs,
          SUM(CASE WHEN time_to_first_token_ms IS NOT NULL THEN time_to_first_token_ms ELSE 0 END) AS ttftSumMs,
          SUM(CASE WHEN time_to_first_token_ms IS NOT NULL THEN 1 ELSE 0 END) AS ttftSampleCount
        FROM model_usage
        WHERE status='completed' ${rangeClause(range)}
        GROUP BY provider_id
      ),
      total AS (SELECT SUM(totalTokens) AS s FROM agg)
      SELECT
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
             ELSE 0 END          AS share,
        agg.totalDurationMs       AS totalDurationMs,
        agg.durationSampleCount   AS durationSampleCount,
        agg.speedSampleCount      AS speedSampleCount,
        agg.speedOutputTokens     AS speedOutputTokens,
        agg.speedDurationMs       AS speedDurationMs,
        agg.ttftSumMs             AS ttftSumMs,
        agg.ttftSampleCount       AS ttftSampleCount
      FROM agg, total
      ORDER BY totalTokens DESC
      LIMIT 5000
    `
    return { sql }
  },

  /**
   * 按 provider_id + model_id 聚合：用于供应商详情页列出该供应商下所有模型。
   */
  byProviderModel(range: Range, providerId: string): ParamQuery {
    const bind: unknown[] = [providerId, providerId]
    const sql = `
      WITH agg AS (
        SELECT
          model_id,
          COUNT(*) AS calls,
          SUM(computed_total_tokens) AS totalTokens,
          SUM(input_tokens) AS inputTokens,
          SUM(output_tokens) AS outputTokens,
          SUM(reasoning_tokens) AS reasoningTokens,
          SUM(cache_read_input_tokens) AS cacheReadTokens,
          SUM(cache_creation_input_tokens) AS cacheCreationTokens,
          SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errorCount,
          SUM(CASE WHEN duration_ms > 0 THEN duration_ms ELSE 0 END) AS totalDurationMs,
          SUM(CASE WHEN duration_ms > 0 THEN 1 ELSE 0 END) AS durationSampleCount,
          SUM(CASE WHEN ${SPEED_VALID} THEN 1 ELSE 0 END) AS speedSampleCount,
          SUM(CASE WHEN ${SPEED_VALID} THEN output_tokens ELSE 0 END) AS speedOutputTokens,
          SUM(CASE WHEN ${SPEED_VALID} THEN duration_ms - time_to_first_token_ms ELSE 0 END) AS speedDurationMs,
          SUM(CASE WHEN time_to_first_token_ms IS NOT NULL THEN time_to_first_token_ms ELSE 0 END) AS ttftSumMs,
          SUM(CASE WHEN time_to_first_token_ms IS NOT NULL THEN 1 ELSE 0 END) AS ttftSampleCount
        FROM model_usage
        WHERE status='completed' AND provider_id = ? ${rangeClause(range)}
        GROUP BY model_id
      ),
      total AS (SELECT SUM(totalTokens) AS s FROM agg)
      SELECT
        ? AS providerId,
        agg.model_id              AS modelId,
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
             ELSE 0 END          AS share,
        agg.totalDurationMs       AS totalDurationMs,
        agg.durationSampleCount   AS durationSampleCount,
        agg.speedSampleCount      AS speedSampleCount,
        agg.speedOutputTokens     AS speedOutputTokens,
        agg.speedDurationMs       AS speedDurationMs,
        agg.ttftSumMs             AS ttftSumMs,
        agg.ttftSampleCount       AS ttftSampleCount
      FROM agg, total
      ORDER BY totalTokens DESC
      LIMIT 5000
    `
    return { sql, bind }
  },

  /**
   * 按 provider_id + model_id + day 聚合：用于供应商-模型详情页的日趋势图。
   */
  byDayByProviderModel(range: Range, providerId: string, modelId: string): ParamQuery {
    const bind: unknown[] = [providerId, modelId]
    const tzOffsetMs = timezoneOffsetMs()
    const sql = `
      SELECT
        strftime('%Y-%m-%d', (started_at - ${tzOffsetMs})/1000, 'unixepoch') AS day,
        SUM(input_tokens)                                   AS inputTokens,
        SUM(output_tokens)                                  AS outputTokens,
        SUM(reasoning_tokens)                               AS reasoningTokens,
        SUM(cache_read_input_tokens)                        AS cacheReadTokens,
        SUM(cache_creation_input_tokens)                    AS cacheCreationTokens,
        SUM(CASE WHEN duration_ms > 0 THEN duration_ms ELSE 0 END) AS totalDurationMs,
        SUM(CASE WHEN duration_ms > 0 THEN 1 ELSE 0 END) AS durationSampleCount,
        SUM(CASE WHEN ${SPEED_VALID} THEN 1 ELSE 0 END) AS speedSampleCount,
        SUM(CASE WHEN ${SPEED_VALID} THEN output_tokens ELSE 0 END) AS speedOutputTokens,
        SUM(CASE WHEN ${SPEED_VALID} THEN duration_ms - time_to_first_token_ms ELSE 0 END) AS speedDurationMs,
        SUM(CASE WHEN time_to_first_token_ms IS NOT NULL AND time_to_first_token_ms >= 0 THEN time_to_first_token_ms ELSE 0 END) AS ttftSumMs,
        SUM(CASE WHEN time_to_first_token_ms IS NOT NULL AND time_to_first_token_ms >= 0 THEN 1 ELSE 0 END) AS ttftSampleCount
      FROM model_usage
      WHERE status='completed'
        AND provider_id = ?
        AND model_id = ?
        ${rangeClause(range)}
      GROUP BY day
      ORDER BY day ASC
    `
    return { sql, bind }
  },

  /**
   * 按 provider_id + model_id + (weekday, hour) 聚合：用于供应商-模型详情页的小时分布图。
   */
  byHourByProviderModel(range: Range, providerId: string, modelId: string): ParamQuery {
    const bind: unknown[] = [providerId, modelId]
    const tzOffsetMs = timezoneOffsetMs()
    const sql = `
      SELECT
        CAST(strftime('%w', (started_at - ${tzOffsetMs})/1000, 'unixepoch') AS INTEGER) AS weekday,
        CAST(strftime('%H', (started_at - ${tzOffsetMs})/1000, 'unixepoch') AS INTEGER) AS hour,
        COUNT(*)                                                       AS calls,
        SUM(computed_total_tokens)                                     AS totalTokens,
        SUM(CASE WHEN duration_ms > 0 THEN duration_ms ELSE 0 END)       AS totalDurationMs,
        SUM(CASE WHEN duration_ms > 0 THEN 1 ELSE 0 END)                AS durationSampleCount,
        SUM(CASE WHEN ${SPEED_VALID} THEN 1 ELSE 0 END) AS speedSampleCount,
        SUM(CASE WHEN ${SPEED_VALID} THEN output_tokens ELSE 0 END) AS speedOutputTokens,
        SUM(CASE WHEN ${SPEED_VALID} THEN duration_ms - time_to_first_token_ms ELSE 0 END) AS speedDurationMs,
        SUM(CASE WHEN time_to_first_token_ms IS NOT NULL AND time_to_first_token_ms >= 0 THEN time_to_first_token_ms ELSE 0 END) AS ttftSumMs,
        SUM(CASE WHEN time_to_first_token_ms IS NOT NULL AND time_to_first_token_ms >= 0 THEN 1 ELSE 0 END) AS ttftSampleCount
      FROM model_usage
      WHERE status='completed'
        AND provider_id = ?
        AND model_id = ?
        ${rangeClause(range)}
      GROUP BY weekday, hour
    `
    return { sql, bind }
  },

  /**
   * 按 "session_id × model_id" 展开：每行 4 项分项 token，用于按会话成本列。
   * 主线程会按 model_id 单价加权求和。
   */
  bySessionByModel(range: Range): ParamQuery {
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

  /**
   * 按 turn × model_id 展开：每行 4 项分项 token。
   * 主线程先按 (turn, model) 算出成本，再在每个 turn 内找 token 占比最高的 model 作为主模型，
   * 最后按主模型分组得到「平均每个 Prompt 的成本/token」。
   */
  byPromptByModel(range: Range): ParamQuery {
    const sql = `
      SELECT
        turn_id                                               AS turnId,
        model_id                                              AS modelId,
        COUNT(*)                                              AS calls,
        SUM(input_tokens)                                     AS inputTokens,
        SUM(output_tokens)                                    AS outputTokens,
        SUM(reasoning_tokens)                                 AS reasoningTokens,
        SUM(cache_read_input_tokens)                          AS cacheReadTokens,
        SUM(cache_creation_input_tokens)                      AS cacheCreationTokens
      FROM model_usage
      WHERE status='completed' AND turn_id IS NOT NULL ${rangeClause(range)}
      GROUP BY turn_id, model_id
    `
    return { sql }
  },

  /**
   * 每个 turn 的整体聚合：调用次数、总 token、时间跨度、错误数。
   * 与 byPromptByModel 一起用于 Prompt 明细和主模型归因。
   */
  byPromptSummary(range: Range): ParamQuery {
    const sql = `
      SELECT
        turn_id                                               AS turnId,
        COUNT(*)                                              AS modelCalls,
        SUM(computed_total_tokens)                            AS totalTokens,
        SUM(CASE WHEN status='error' THEN 1 ELSE 0 END)     AS errorCount,
        MIN(started_at)                                       AS firstSeen,
        MAX(completed_at)                                     AS lastSeen
      FROM model_usage
      WHERE turn_id IS NOT NULL ${rangeClause(range)}
      GROUP BY turn_id
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
      AVG(CASE WHEN duration_ms > 0 THEN duration_ms END)             AS avgDurationMs,
      SUM(COALESCE(output_bytes, 0))                                  AS totalOutputBytes,
      AVG(CASE WHEN duration_ms > 0 THEN COALESCE(output_bytes, 0) END) AS avgOutputBytes
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
   * 错误 / 上下文超限 / 取消 / 含重试行的成本明细：每行 (model_id, 各分项 token)。
   * 主线程按 model_id 单价加权求和 = "错误 / 重试烧掉的钱"。
   * retry_count>0 的成功行被纳入,因重试产生的 token 成本只发生在这些行上。
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
    WHERE status='error'
       OR context_exceeded=1
       OR cancelled_by_user=1
       OR retry_count > 0
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

function computeTimingAggregates(
  speedOutputTokens: number,
  speedDurationMs: number,
  speedSampleCount: number,
  ttftSumMs: number,
  ttftSampleCount: number,
  totalDurationMs: number,
  durationSampleCount: number,
): TimingAggregates {
  return {
    speedOutputTokens,
    speedDurationMs,
    speedSampleCount,
    ttftSumMs,
    ttftSampleCount,
    totalDurationMs,
    durationSampleCount,
    avgOutputSpeed: speedDurationMs > 0 ? (speedOutputTokens / speedDurationMs) * 1000 : null,
    avgTtftMs: ttftSampleCount > 0 ? ttftSumMs / ttftSampleCount : null,
    avgDurationMs: durationSampleCount > 0 ? totalDurationMs / durationSampleCount : null,
  }
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
  const timing = computeTimingAggregates(
    toNumber(m[17]),
    toNumber(m[18]),
    toNumber(m[16]),
    toNumber(m[19]),
    toNumber(m[20]),
    toNumber(m[14]),
    toNumber(m[15]),
  )
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
    cancelCount: toNumber(m[9]),
    retryTotal: toNumber(m[10]),
    firstSeen: toNumberOrNull(m[11]),
    lastSeen: toNumberOrNull(m[12]),
    activeDays: toNumber(m[13]),
    toolCallCount: toNumber(t[0]),
    toolErrorCount: toNumber(t[1]),
    cacheHitRate,
    cost,
    ...timing,
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
    const timing = computeTimingAggregates(
      toNumber(row[15]),
      toNumber(row[16]),
      toNumber(row[14]),
      toNumber(row[17]),
      toNumber(row[18]),
      toNumber(row[12]),
      toNumber(row[13]),
    )
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
      ...timing,
    }
  })
}

export function shapeByDay(
  r: WorkerExecResult,
  /** 来自 byDayByModel 的成本按 day 折叠 */
  costByDay: ReadonlyMap<string, number>,
): ByDayRow[] {
  return r.rows.map((row) => {
    const timing = computeTimingAggregates(
      toNumber(row[13]),
      toNumber(row[14]),
      toNumber(row[12]),
      toNumber(row[15]),
      toNumber(row[16]),
      toNumber(row[10]),
      toNumber(row[11]),
    )
    return {
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
      ...timing,
    }
  })
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
  return r.rows.map((row) => {
    const timing = computeTimingAggregates(
      toNumber(row[10]),
      toNumber(row[11]),
      toNumber(row[9]),
      toNumber(row[12]),
      toNumber(row[13]),
      toNumber(row[7]),
      toNumber(row[8]),
    )
    return {
      day: String(row[0] ?? ''),
      modelId: String(row[1] ?? ''),
      inputTokens: toNumber(row[2]),
      outputTokens: toNumber(row[3]),
      reasoningTokens: toNumber(row[4]),
      cacheReadTokens: toNumber(row[5]),
      cacheCreationTokens: toNumber(row[6]),
      ...timing,
    }
  })
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

/** speedTrend 的列序：bucket, modelId, speedOutputTokens, speedDurationMs, speedSampleCount, ttftSumMs, ttftSampleCount, speedMaxTokPerS, speedMinTokPerS */
export function shapeSpeedTrend(r: WorkerExecResult): SpeedTrendRow[] {
  return r.rows.map((row) => ({
    bucket: String(row[0] ?? ''),
    modelId: String(row[1] ?? ''),
    speedOutputTokens: toNumber(row[2]),
    speedDurationMs: toNumber(row[3]),
    speedSampleCount: toNumber(row[4]),
    ttftSumMs: toNumber(row[5]),
    ttftSampleCount: toNumber(row[6]),
    speedMaxTokPerS: toNumberOrNull(row[7]),
    speedMinTokPerS: toNumberOrNull(row[8]),
  }))
}

/** speedTrendSamples 的列序：bucket, modelId, speedTokPerS */
export function shapeSpeedTrendSamples(r: WorkerExecResult): SpeedSampleRow[] {
  return r.rows.map((row) => ({
    bucket: String(row[0] ?? ''),
    modelId: String(row[1] ?? ''),
    speedTokPerS: toNumber(row[2]),
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
  const cells = r.rows.map((row) => {
    const durationSampleCount = toNumber(row[5])
    const speedDurationMs = toNumber(row[8])
    const speedSampleCount = toNumber(row[6])
    const ttftSumMs = toNumber(row[9])
    const ttftSampleCount = toNumber(row[10])
    return {
      weekday: toNumber(row[0]),
      hour: toNumber(row[1]),
      calls: toNumber(row[2]),
      totalTokens: toNumber(row[3]),
      speedOutputTokens: toNumber(row[7]),
      speedDurationMs,
      speedSampleCount,
      ttftSumMs,
      ttftSampleCount,
      totalDurationMs: toNumber(row[4]),
      durationSampleCount,
      avgOutputSpeed: speedDurationMs > 0 ? (toNumber(row[7]) / speedDurationMs) * 1000 : null,
      avgTtftMs: ttftSampleCount > 0 ? ttftSumMs / ttftSampleCount : null,
      avgDurationMs: durationSampleCount > 0 ? toNumber(row[4]) / durationSampleCount : null,
    }
  })
  const maxTokens = cells.reduce((m, c) => (c.totalTokens > m ? c.totalTokens : m), 0)
  return { cells, maxTokens }
}

export function shapeByProvider(r: WorkerExecResult): ByProviderRow[] {
  return r.rows.map((row) => {
    const inputTokens = toNumber(row[4])
    const outputTokens = toNumber(row[5])
    const reasoningTokens = toNumber(row[6])
    const cacheReadTokens = toNumber(row[7])
    const cacheCreationTokens = toNumber(row[8])
    const providerId = String(row[0] ?? '?')
    const timing = computeTimingAggregates(
      toNumber(row[14]),
      toNumber(row[15]),
      toNumber(row[13]),
      toNumber(row[16]),
      toNumber(row[17]),
      toNumber(row[11]),
      toNumber(row[12]),
    )
    return {
      providerId,
      calls: toNumber(row[1]),
      totalTokens: toNumber(row[2]),
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheCreationTokens,
      errorCount: toNumber(row[9]),
      cacheHitRate: toNumber(row[10]),
      share: toNumber(row[11]),
      cost: 0,
      ...timing,
    }
  })
}

export function shapeByProviderModel(r: WorkerExecResult): ByProviderModelRow[] {
  return r.rows.map((row) => {
    const inputTokens = toNumber(row[5])
    const outputTokens = toNumber(row[6])
    const reasoningTokens = toNumber(row[7])
    const cacheReadTokens = toNumber(row[8])
    const cacheCreationTokens = toNumber(row[9])
    const providerId = String(row[0] ?? '?')
    const modelId = String(row[1] ?? '')
    const timing = computeTimingAggregates(
      toNumber(row[15]),
      toNumber(row[16]),
      toNumber(row[14]),
      toNumber(row[17]),
      toNumber(row[18]),
      toNumber(row[12]),
      toNumber(row[13]),
    )
    return {
      providerId,
      modelId,
      calls: toNumber(row[2]),
      totalTokens: toNumber(row[3]),
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheCreationTokens,
      errorCount: toNumber(row[10]),
      cacheHitRate: toNumber(row[11]),
      share: toNumber(row[12]),
      cost: costFor(modelId, {
        inputTokens,
        outputTokens,
        reasoningTokens,
        cacheReadTokens,
        cacheCreationTokens,
      }),
      ...timing,
    }
  })
}

export function shapeByDayByProviderModel(r: WorkerExecResult): ByDayRow[] {
  return r.rows.map((row) => {
    const timing = computeTimingAggregates(
      toNumber(row[9]),
      toNumber(row[10]),
      toNumber(row[8]),
      toNumber(row[11]),
      toNumber(row[12]),
      toNumber(row[6]),
      toNumber(row[7]),
    )
    return {
      day: String(row[0] ?? ''),
      calls: 0,
      totalTokens: 0,
      inputTokens: toNumber(row[1]),
      outputTokens: toNumber(row[2]),
      cacheReadTokens: toNumber(row[4]),
      cacheCreationTokens: toNumber(row[5]),
      errorCount: 0,
      cacheHitRate: 0,
      reasoningTokens: toNumber(row[3]),
      cost: 0,
      ...timing,
    }
  })
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

export function shapeByPromptByModel(r: WorkerExecResult): ByPromptByModelRow[] {
  return r.rows.map((row) => ({
    turnId: String(row[0] ?? ''),
    modelId: String(row[1] ?? ''),
    calls: toNumber(row[2]),
    inputTokens: toNumber(row[3]),
    outputTokens: toNumber(row[4]),
    reasoningTokens: toNumber(row[5]),
    cacheReadTokens: toNumber(row[6]),
    cacheCreationTokens: toNumber(row[7]),
  }))
}

export function shapeByPromptSummary(r: WorkerExecResult): ByPromptSummaryRow[] {
  return r.rows.map((row) => ({
    turnId: String(row[0] ?? ''),
    modelCalls: toNumber(row[1]),
    totalTokens: toNumber(row[2]),
    errorCount: toNumber(row[3]),
    firstSeen: toNumberOrNull(row[4]),
    lastSeen: toNumberOrNull(row[5]),
  }))
}

/**
 * 把 (turn × model) 明细折叠成每个 turn 的明细，并找出主模型。
 * 主模型 = 该 turn 内各分项 token 之和最大的 model_id。
 * 一次 turn 的全部 token/cost 都归因到这个主模型上。
 */
export function aggregateByPrompt(
  byModelRows: readonly ByPromptByModelRow[],
  summaryRows: readonly ByPromptSummaryRow[],
): ByPromptDetailRow[] {
  type ModelSlice = {
    modelId: string
    calls: number
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    cost: number
  }

  const byTurn = new Map<string, ModelSlice[]>()
  for (const r of byModelRows) {
    const slice: ModelSlice = {
      modelId: r.modelId,
      calls: r.calls,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      reasoningTokens: r.reasoningTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      cost: costFor(r.modelId, r),
    }
    const arr = byTurn.get(r.turnId) ?? []
    arr.push(slice)
    byTurn.set(r.turnId, arr)
  }

  const summaryMap = new Map<string, ByPromptSummaryRow>()
  for (const s of summaryRows) summaryMap.set(s.turnId, s)

  const details: ByPromptDetailRow[] = []
  for (const [turnId, slices] of byTurn) {
    // 主模型：分项 token 总和最大的那个 model_id
    let primary = slices[0]
    if (!primary) continue
    for (const s of slices) {
      const sTokens =
        s.inputTokens +
        s.outputTokens +
        s.reasoningTokens +
        s.cacheReadTokens +
        s.cacheCreationTokens
      const pTokens =
        primary.inputTokens +
        primary.outputTokens +
        primary.reasoningTokens +
        primary.cacheReadTokens +
        primary.cacheCreationTokens
      if (sTokens > pTokens) primary = s
    }

    const totalTokens = slices.reduce(
      (sum, s) =>
        sum +
        s.inputTokens +
        s.outputTokens +
        s.reasoningTokens +
        s.cacheReadTokens +
        s.cacheCreationTokens,
      0,
    )
    const inputTokens = slices.reduce((sum, s) => sum + s.inputTokens, 0)
    const outputTokens = slices.reduce((sum, s) => sum + s.outputTokens, 0)
    const reasoningTokens = slices.reduce((sum, s) => sum + s.reasoningTokens, 0)
    const cacheReadTokens = slices.reduce((sum, s) => sum + s.cacheReadTokens, 0)
    const cacheCreationTokens = slices.reduce((sum, s) => sum + s.cacheCreationTokens, 0)
    const cost = slices.reduce((sum, s) => sum + s.cost, 0)
    const calls = slices.reduce((sum, s) => sum + s.calls, 0)
    const summary = summaryMap.get(turnId)

    details.push({
      turnId,
      primaryModelKey: primary.modelId,
      primaryModelDisplay: primary.modelId,
      modelCalls: calls,
      totalTokens,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheCreationTokens,
      errorCount: summary?.errorCount ?? 0,
      cost,
      firstSeen: summary?.firstSeen ?? null,
      lastSeen: summary?.lastSeen ?? null,
    })
  }

  // 按发生时间降序，方便明细表看最近 Prompt
  details.sort((a, b) => (b.firstSeen ?? 0) - (a.firstSeen ?? 0))
  return details
}

export type RawSqlResult = SqlExecResult
