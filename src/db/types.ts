// Shared row types used by pages and the worker. Keep this file tiny and
// pure-types so it can be imported by both UI and worker code without
// pulling in VFS / sqlite3 references.

/** 输出速度与首 token 延迟的派生指标 */
export type TimingStats = {
  /** 解码速度 = output_tokens / (duration_ms − TTFT) × 1000（tok/s）；无有效样本时为 null。
   *  不含「等首个 token」的等待时间；仅统计记录了有效 TTFT 的调用 */
  avgOutputSpeed: number | null
  /** time_to_first_token_ms 平均值（ms）；无有效样本时为 null */
  avgTtftMs: number | null
  /** duration_ms 平均值（ms）；无有效样本时为 null */
  avgDurationMs: number | null
  /** 参与速度计算的调用数（须含有效 TTFT） */
  speedSampleCount: number
  /** 参与 TTFT 计算的调用数 */
  ttftSampleCount: number
}

/** 用于需要跨行重新聚合的中间字段（如按模型名/供应商分组） */
export type TimingAggregates = TimingStats & {
  /** 参与速度计算的 output_tokens 累加 */
  speedOutputTokens: number
  /** 参与速度计算的解码时长累加（duration_ms − TTFT，ms） */
  speedDurationMs: number
  /** 参与 TTFT 计算的 time_to_first_token_ms 累加（ms） */
  ttftSumMs: number
  /** 参与耗时计算的 duration_ms 累加（ms） */
  totalDurationMs: number
  /** 参与耗时计算的调用数（duration_ms > 0 的 completed 调用） */
  durationSampleCount: number
}

export type OverviewKpis = TimingAggregates & {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  modelCallCount: number
  modelErrorCount: number
  contextExceededCount: number
  cancelCount: number
  toolCallCount: number
  toolErrorCount: number
  retryTotal: number
  activeDays: number
  /** cache_read / (input + cache_creation) */
  cacheHitRate: number
  firstSeen: number | null
  lastSeen: number | null
  /** ¥ 估算成本 */
  cost: number
}

export type ByModelRow = TimingAggregates & {
  modelId: string
  providerId: string
  calls: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  errorCount: number
  /** cache_read / (input + cache_creation)；无分母时为 0（与 SQL 实现口径一致） */
  cacheHitRate: number
  share: number
  /** ¥ 估算成本（per-id 计算后求和） */
  cost: number
}

export type ByProviderRow = TimingAggregates & {
  providerId: string
  calls: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  errorCount: number
  /** cache_read / (input + cache_creation)；无分母时为 0（与 SQL 实现口径一致） */
  cacheHitRate: number
  share: number
  /** ¥ 估算成本 */
  cost: number
}

export type ByProviderModelRow = TimingAggregates & {
  providerId: string
  modelId: string
  calls: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  errorCount: number
  /** cache_read / (input + cache_creation)；无分母时为 0（与 SQL 实现口径一致） */
  cacheHitRate: number
  share: number
  /** ¥ 估算成本 */
  cost: number
}

export type ByDayRow = TimingAggregates & {
  day: string
  calls: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  errorCount: number
  cacheHitRate: number
  reasoningTokens: number
  /** ¥ 估算成本 */
  cost: number
}

export type ByDayByModelRow = TimingAggregates & {
  day: string
  modelId: string
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

/** 速度趋势页的「本地小时桶 × model_id」行；页面按 日/周 粒度在前端再折叠。
 *  速度字段仅统计正常生成请求（query_source 白名单，见 queries.ts SPEED_SAMPLE）；
 *  极值字段另要求解码窗口 ≥3s 且输出 ≥32 token（SPEED_EXTREME） */
export type SpeedTrendRow = {
  /** 本地时区小时桶，格式 'YYYY-MM-DDTHH' */
  bucket: string
  modelId: string
  speedOutputTokens: number
  speedDurationMs: number
  speedSampleCount: number
  ttftSumMs: number
  ttftSampleCount: number
  /** 桶内单次调用解码速度的最大/最小值（tok/s，SPEED_EXTREME 口径）；无合格样本为 null */
  speedMaxTokPerS: number | null
  speedMinTokPerS: number | null
}

/** 速度页中位数口径的单次调用速度明细（见 queries.ts speedTrendSamples / SPEED_SAMPLE）。
 *  中位数不能跨桶合并，前端按目标粒度折叠后自行取中位 */
export type SpeedSampleRow = {
  /** 本地时区小时桶，格式 'YYYY-MM-DDTHH' */
  bucket: string
  modelId: string
  /** 单次调用的纯解码速度（tok/s） */
  speedTokPerS: number
}

export type BySessionByModelRow = {
  sessionId: string
  modelId: string
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export type BySessionRow = {
  sessionId: string
  title: string | null
  directory: string | null
  taskType: string | null
  calls: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  firstSeen: number | null
  lastSeen: number | null
  /** ¥ 估算成本 */
  cost: number
}

export type ByHourCell = TimingAggregates & {
  weekday: number // 0=Sun … 6=Sat
  hour: number // 0-23
  calls: number
  totalTokens: number
}

export type ByHourGrid = {
  cells: ByHourCell[]
  maxTokens: number
}

export type ByToolRow = {
  toolName: string
  calls: number
  errorCount: number
  errorRate: number
  avgDurationMs: number | null
  totalOutputBytes: number
  avgOutputBytes: number
}

/** turn × model 明细：用于主线程计算每个 turn 的成本并找主模型 */
export type ByPromptByModelRow = {
  turnId: string
  modelId: string
  calls: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

/** 每个 turn 的整体聚合 */
export type ByPromptSummaryRow = {
  turnId: string
  modelCalls: number
  totalTokens: number
  errorCount: number
  firstSeen: number | null
  lastSeen: number | null
}

/** 按模型聚合后的 Prompt 统计（展示用） */
export type ByPromptModelRow = {
  groupKey: string
  displayName: string
  modelIds: string[]
  merged: boolean
  marked: boolean
  recognized: boolean
  promptCount: number
  calls: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  errorCount: number
  cost: number
  avgTokensPerPrompt: number
  avgCostPerPrompt: number
  avgCallsPerPrompt: number
}

/** 每个 Prompt（turn）的明细 */
export type ByPromptDetailRow = {
  turnId: string
  primaryModelKey: string
  primaryModelDisplay: string
  modelCalls: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  errorCount: number
  cost: number
  firstSeen: number | null
  lastSeen: number | null
}

export type ErrorsOverview = {
  totalCalls: number
  errorCount: number
  errorRate: number
  contextExceededCount: number
  retryCount: number
  cancelCount: number
  byStatus: { status: string; n: number }[]
  byErrorType: { errorType: string | null; n: number }[]
  retryDistribution: { retryCount: number; n: number }[]
}

export type SqlExecResult = {
  columns: string[]
  rows: unknown[][]
  rowsAffected: number
  lastInsertRowid: number | null
  durationMs: number
}
