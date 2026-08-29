// 价目表 (¥ / 1M token) 与成本估算。
//
// 表里只给了"输入 / 输出 / 缓存输入"三档：缓存写、reasoning 没单独给价。约定：
//   缓存写按"输入价"计（业界常见做法，因为 cache 写比 input 写更便宜的部分由
//   ZCode 套餐内部吸收；这里给最坏估计）
//   reasoning 并入"输出价"（因为推理 token 跟输出 token 一样是模型生成）
// 公式：
//   成本 = (输入 + 缓存写) × 输入价 + (输出 + reasoning) × 输出价 + 缓存读 × 缓存价
//
// 模型匹配链（按顺序）：
//   1) 用户标记：model_id → 内置模型名 / 自定义模型名（直接命中）
//   2) 精确匹配 TABLE (大小写敏感)
//   3) 归一化后匹配 TABLE：去 provider 前缀 (openrouter/xxx → xxx)，全小写
//   4) 归一化后匹配自定义模型表
//   5) 内置别名查表（stealth/ox-alpha → GLM-5.3-Flash），大小写不敏感
//   6) 都不中 → 默认按 deepseek-v4-pro
//
// 用户标记 / 自定义模型由 model-groups.ts 注入（setMarks / setCustomModels）；
// pricing 不反向引用 model-groups，避免循环。
//
// 缓存按 dbKey 隔离：close / 换 db 时不会拿旧价。

export type ModelPrice = {
  input: number // ¥ / 1M
  output: number
  cacheInput: number
}

const TABLE: Record<string, ModelPrice> = {
  'deepseek-v4-flash': { input: 3.0, output: 9.0, cacheInput: 0.1 },
  'deepseek-v4-pro': { input: 9.0, output: 27.0, cacheInput: 0.3 },
  'minimax-m3': { input: 4.2, output: 16.8, cacheInput: 0.84 },
  'GLM-5.3-Flash': { input: 0.4, output: 1.4, cacheInput: 0.115 },
  'GLM-5.3': { input: 8.0, output: 28.0, cacheInput: 2.0 },
  'mimo-v2.5-pro': { input: 3.0, output: 6.0, cacheInput: 0.025 },
  'kimi-for-coding': { input: 6.84, output: 27.0, cacheInput: 1.37 },
  'mimo-v2.5': { input: 1.0, output: 2.0, cacheInput: 0.02 },
  'glm-5.2': { input: 8.0, output: 28.0, cacheInput: 2.0 },
  'Kimi K3': { input: 21.6, output: 108.0, cacheInput: 2.16 },
  'GLM-5-Turbo': { input: 5.0, output: 22.0, cacheInput: 1.2 },
  'grok-4.6': { input: 14.4, output: 43.2, cacheInput: 3.6 },
  'grok-4.5': { input: 14.4, output: 43.2, cacheInput: 2.16 },
  'grok-4.3': { input: 9.0, output: 18.0, cacheInput: 1.44 },
  'grok-4.20': { input: 9.0, output: 18.0, cacheInput: 1.44 },
  'grok-build-0.1': { input: 7.2, output: 14.4, cacheInput: 1.44 },
  'gpt-5.6-sol': { input: 36.0, output: 216.0, cacheInput: 3.6 },
  'gpt-5.6-terra': { input: 14.4, output: 86.4, cacheInput: 1.44 },
  'gpt-5.6-luna': { input: 1.44, output: 8.64, cacheInput: 0.14 },
  'gpt-5.5': { input: 36.0, output: 216.0, cacheInput: 3.6 },
  'gpt-5.4': { input: 18.0, output: 108.0, cacheInput: 1.8 },
  'gpt-5.4-mini': { input: 5.4, output: 32.4, cacheInput: 0.54 },
  'gpt-5.4-nano': { input: 1.44, output: 9.0, cacheInput: 0.14 },
  'gpt-5': { input: 9.0, output: 72.0, cacheInput: 0.9 },
  'gpt-5-mini': { input: 1.8, output: 14.4, cacheInput: 0.18 },
  'gpt-5-nano': { input: 0.36, output: 2.88, cacheInput: 0.04 },
  'gpt-4o': { input: 18.0, output: 72.0, cacheInput: 9.0 },
  'gpt-4o-mini': { input: 1.08, output: 4.32, cacheInput: 0.54 },
  'claude-opus-5': { input: 36.0, output: 180.0, cacheInput: 3.6 },
  'claude-opus-4.8': { input: 36.0, output: 180.0, cacheInput: 3.6 },
  'claude-sonnet-4.6': { input: 21.6, output: 108.0, cacheInput: 2.16 },
  'claude-haiku-4.5': { input: 7.2, output: 36.0, cacheInput: 0.72 },
}

/**
 * 内置别名（保持跟 model-groups.ts applyBuiltin 同步）：键全小写，
 * 命中后返回价目表里存在的目标 id。这里是 pricing 的本地副本，
 * 避免运行时依赖 model-groups。
 */
const BUILTIN_ALIASES_LC: Record<string, string> = {
  'openrouter/sonoma/stealth/ox-alpha': 'GLM-5.3-Flash',
  'openrouter/sonoma/stealth/ox': 'GLM-5.3-Flash',
  'openrouter/sonoma/stealth': 'GLM-5.3-Flash',
}

// ---- 用户注入的注册表 ----
// marks: modelId → 目标模型名（内置 key 或自定义名）
// customModels: 自定义模型名 → 单价
let marks: Record<string, string> = {}
let customModels: Record<string, ModelPrice> = {}

/** 设置当前 model_id 标记。每次写入会清空所有 dbKey 的价格缓存。 */
export function setMarks(next: Record<string, string>): void {
  marks = next
  clearPriceCache('*')
}

/** 设置当前自定义模型表。每次写入会清空所有 dbKey 的价格缓存。 */
export function setCustomModels(next: Record<string, ModelPrice>): void {
  customModels = next
  clearPriceCache('*')
}

/** 给下拉列表用：内置价目表的所有 key，按字母序。 */
export function builtinModelKeys(): string[] {
  return Object.keys(TABLE).sort()
}

/** 内部 / 测试用：读当前 marks 快照。 */
export function getMarks(): Record<string, string> {
  return marks
}

/** 内部 / 测试用：读当前 custom models 快照。 */
export function getCustomModels(): Record<string, ModelPrice> {
  return customModels
}

// 切 provider 前缀（与 model-groups.normalizeModelName 行为一致 — 不要重复实现逻辑）
function normalizeForPrice(modelId: string): string {
  const slash = modelId.lastIndexOf('/')
  const base = slash >= 0 ? modelId.slice(slash + 1) : modelId
  return base.trim() || modelId
}

function tableKeyByName(name: string): string | null {
  if (TABLE[name]) return name
  const norm = normalizeForPrice(name).toLowerCase().trim()
  for (const key of Object.keys(TABLE)) {
    if (normalizeForPrice(key).toLowerCase().trim() === norm) return key
  }
  return null
}

function customKeyByName(name: string): string | null {
  if (customModels[name]) return name
  const norm = normalizeForPrice(name).toLowerCase().trim()
  for (const key of Object.keys(customModels)) {
    if (normalizeForPrice(key).toLowerCase().trim() === norm) return key
  }
  return null
}

function findInTableKey(modelId: string): string {
  // 1) 用户标记：精确命中内置或自定义
  const marked = marks[modelId]
  if (marked) {
    const inTable = tableKeyByName(marked)
    if (inTable) return inTable
    const inCustom = customKeyByName(marked)
    if (inCustom) return inCustom
    // 悬空标记（目标被删了）→ 当作未标记，继续往下走
  }
  // 2) 精确匹配 TABLE
  if (TABLE[modelId]) return modelId
  // 3) 归一化后匹配 TABLE
  const norm = normalizeForPrice(modelId).toLowerCase().trim()
  for (const key of Object.keys(TABLE)) {
    if (normalizeForPrice(key).toLowerCase().trim() === norm) return key
  }
  // 4) 归一化后匹配自定义
  for (const key of Object.keys(customModels)) {
    if (normalizeForPrice(key).toLowerCase().trim() === norm) return key
  }
  // 5) 内置别名（与 model-groups.applyBuiltin 行为一致；大小写不敏感）
  const builtin = BUILTIN_ALIASES_LC[modelId.toLowerCase()]
  if (builtin) return builtin
  // 6) 默认
  return 'deepseek-v4-pro'
}

// 模糊匹配缓存，按 dbKey 隔离。默认 'default' 是没传 key 时的兜底。
const cachePerKey = new Map<string, Map<string, { price: ModelPrice; matched: string }>>()
const DEFAULT_KEY = 'default'

function getCache(dbKey: string): Map<string, { price: ModelPrice; matched: string }> {
  let c = cachePerKey.get(dbKey)
  if (!c) {
    c = new Map()
    cachePerKey.set(dbKey, c)
  }
  return c
}

function findInTable(
  modelId: string,
  dbKey: string,
): { price: ModelPrice; matched: string } {
  const cache = getCache(dbKey)
  const cached = cache.get(modelId)
  if (cached) return cached
  const matched = findInTableKey(modelId)
  const price = TABLE[matched] ?? customModels[matched]
  if (!price) {
    // 理论上不会到这（findInTableKey 永远返回某个 key，且默认 deepseek-v4-pro 在 TABLE 里）
    // 但保险起见
    const fallback = TABLE['deepseek-v4-pro']!
    return { price: fallback, matched: 'deepseek-v4-pro (默认)' }
  }
  const isDefault = matched === 'deepseek-v4-pro' && !TABLE[modelId] && !BUILTIN_ALIASES_LC[modelId.toLowerCase()] && !isMarkedToRecognized(modelId)
  const displayMatched =
    isMarkedToRecognized(modelId) && !TABLE[modelId] && !BUILTIN_ALIASES_LC[modelId.toLowerCase()]
      ? `${matched} (按标记)`
      : isDefault
        ? 'deepseek-v4-pro (默认)'
        : matched
  const hit = { price, matched: displayMatched }
  cache.set(modelId, hit)
  return hit
}

function isMarkedToRecognized(modelId: string): boolean {
  const m = marks[modelId]
  if (!m) return false
  return tableKeyByName(m) !== null || customKeyByName(m) !== null
}

/** 清空匹配缓存。dbKey='*' 清全部；不传清 default。 */
export function clearPriceCache(dbKey?: string): void {
  if (!dbKey || dbKey === DEFAULT_KEY) {
    cachePerKey.delete(DEFAULT_KEY)
  }
  if (dbKey === '*') {
    cachePerKey.clear()
  } else if (dbKey) {
    cachePerKey.delete(dbKey)
  }
}

/**
 * 这个 model_id 在价目表（含标记 + 自定义）里能不能被"识别"。
 *
 * 不读 cache — 每次调用直接查表 + 走内置别名表。频次受 by-model LIMIT 5000 上限约束，
 * 内部小循环 32 + 自定义数，足够便宜。
 */
export function isRecognizedModel(modelId: string): boolean {
  if (!modelId) return false
  // 1) 标记命中
  const marked = marks[modelId]
  if (marked && (tableKeyByName(marked) || customKeyByName(marked))) return true
  // 2) TABLE 精确
  if (TABLE[modelId]) return true
  // 3) TABLE 归一化
  const norm = normalizeForPrice(modelId).toLowerCase().trim()
  for (const key of Object.keys(TABLE)) {
    if (normalizeForPrice(key).toLowerCase().trim() === norm) return true
  }
  // 4) 自定义归一化
  for (const key of Object.keys(customModels)) {
    if (normalizeForPrice(key).toLowerCase().trim() === norm) return true
  }
  // 5) 内置别名
  if (BUILTIN_ALIASES_LC[modelId.toLowerCase()]) return true
  return false
}

/**
 * 这个 model_id 当前是否有"用户标记"指向一个仍然存在的目标（内置或自定义）。
 * 用于在 list 上打"已标记" Tag，区别于"已识别"（自动匹配到表里的）。
 */
export function isMarkedModel(modelId: string): boolean {
  if (!modelId) return false
  const marked = marks[modelId]
  if (!marked) return false
  return tableKeyByName(marked) !== null || customKeyByName(marked) !== null
}

export type UsageForCost = {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

/** 单条 model_id 的成本 (¥)。内部已感知 marks + customModels。`dbKey` 可选。 */
export function costFor(
  modelId: string,
  u: UsageForCost,
  dbKey: string = DEFAULT_KEY,
): number {
  const { price } = findInTable(modelId, dbKey)
  const inB = (u.inputTokens + u.cacheCreationTokens) / 1_000_000
  const outB = (u.outputTokens + u.reasoningTokens) / 1_000_000
  const cacheB = u.cacheReadTokens / 1_000_000
  return inB * price.input + outB * price.output + cacheB * price.cacheInput
}

/** 成本 + 匹配到的价格表键名（用于显示"按 X 计费"小字） */
export function costForWithMatch(
  modelId: string,
  u: UsageForCost,
  dbKey: string = DEFAULT_KEY,
): { cost: number; matched: string } {
  const { price, matched } = findInTable(modelId, dbKey)
  const inB = (u.inputTokens + u.cacheCreationTokens) / 1_000_000
  const outB = (u.outputTokens + u.reasoningTokens) / 1_000_000
  const cacheB = u.cacheReadTokens / 1_000_000
  return {
    cost: inB * price.input + outB * price.output + cacheB * price.cacheInput,
    matched,
  }
}
