// Shared row types used by pages and the worker. Keep this file tiny and
// pure-types so it can be imported by both UI and worker code without
// pulling in VFS / sqlite3 references.

export type OverviewKpis = {
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
  /** cache_read / (input + cache_creation + cache_read) */
  cacheHitRate: number
  firstSeen: number | null
  lastSeen: number | null
  /** ¥ 估算成本 */
  cost: number
}

export type ByModelRow = {
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
  /** cache_read / (input + cache_creation + cache_read)；无分母时为 0 */
  cacheHitRate: number
  share: number
  /** ¥ 估算成本（per-id 计算后求和） */
  cost: number
}

export type ByDayRow = {
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

export type ByDayByModelRow = {
  day: string
  modelId: string
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
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

export type ByHourCell = {
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
