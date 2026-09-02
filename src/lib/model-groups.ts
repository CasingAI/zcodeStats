// 模型标记（marks）+ 自定义模型（custom models）。
//
// 设计：每个 model_id 可以被「标记」成内置价目表里的某个模型、或用户自建的模型。
// 标记相同 → 自动合并成一组 → 整组按目标模型计价。
//
// 数据流：
//   useMarks / useCustomModels 读 localStorage，写入时同步调 pricing.setMarks / setCustomModels
//   pricing 内部按"标记优先"重新解析 model_id，costFor / isRecognizedModel 都自动感知。
//   resolveGroupKey 用于 list 显示：标记的 id 用标记值作为组名（≈ 目标模型名），未标记走 builtin/normalize。
//
// 持久化键：
//   zcode-stats.model-marks       : Record<modelId, markKey>
//   zcode-stats.custom-models     : Record<markKey, {input, output, cacheInput}>
//
// 跨 tab 用 storage 事件同步。
//
// 旧版本里有"aliases"概念（分组名），但分组名不影响计价。新版本里"标记值=目标模型名"，
// 本身就是合并键 + 计价键，aliases 被自然取代。首次 load 时尝试把旧 aliases
// 解析成 marks（值能命中价目表才转，否则丢弃）。

import { useEffect, useState } from 'preact/hooks'
import {
  builtinModelKeys,
  costFor,
  displayNameOf,
  isRecognizedModel,
  resolveMatch,
  setCustomModels,
  setMarks,
} from './pricing.ts'
import type { ByModelRow, ByProviderModelRow, TimingAggregates } from '../db/types.ts'

const MARKS_KEY = 'zcode-stats.model-marks'
const CUSTOM_KEY = 'zcode-stats.custom-models'
const LEGACY_ALIASES_KEY = 'zcode-stats.model-aliases'

/** modelId → 目标模型名（内置 key 或自定义模型名） */
export type MarkMap = Record<string, string>

export type CustomModel = {
  input: number
  output: number
  cacheInput: number
}

export type CustomModelMap = Record<string, CustomModel>

export type GroupMode = 'id' | 'name'

// ---------- 内部类型：setter 包装 ----------

type Listener = () => void
const listeners = new Set<Listener>()

function notify(): void {
  for (const l of listeners) l()
}

// ---------- localStorage I/O ----------

function safeParse(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const v: unknown = JSON.parse(raw)
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    /* corrupted */
  }
  return {}
}

function stringify(v: unknown): string | null {
  try {
    return JSON.stringify(v)
  } catch {
    return null
  }
}

export function loadMarks(): MarkMap {
  const parsed = safeParse(localStorage.getItem(MARKS_KEY))
  const out: MarkMap = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string' && v.trim()) out[k] = v
  }
  return out
}

/** 写 localStorage + 推送给 pricing + 通知订阅者。 */
export function saveMarks(map: MarkMap): void {
  try {
    const s = stringify(map)
    if (s) localStorage.setItem(MARKS_KEY, s)
  } catch {
    /* storage full / disabled */
  }
  setMarks(map)
  notify()
}

export function loadCustomModels(): CustomModelMap {
  const parsed = safeParse(localStorage.getItem(CUSTOM_KEY))
  const out: CustomModelMap = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (!v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    const input = Number(o.input)
    const output = Number(o.output)
    const cacheInput = Number(o.cacheInput)
    if (
      Number.isFinite(input) &&
      Number.isFinite(output) &&
      Number.isFinite(cacheInput) &&
      input >= 0 &&
      output >= 0 &&
      cacheInput >= 0
    ) {
      out[k] = { input, output, cacheInput }
    }
  }
  return out
}

export function saveCustomModels(map: CustomModelMap): void {
  try {
    const s = stringify(map)
    if (s) localStorage.setItem(CUSTOM_KEY, s)
  } catch {
    /* ignore */
  }
  setCustomModels(map)
  notify()
}

/**
 * 一次性：把旧 aliases 升级到 marks + custom models。仅在 marks+custom 都为空时跑。
 * 规则：alias 值能在内置价目表 / 自定义表里命中 → 升成 mark；否则丢弃。
 */
function migrateLegacyAliases(marksNow: MarkMap, customNow: CustomModelMap): void {
  if (Object.keys(marksNow).length > 0) return
  if (Object.keys(customNow).length > 0) return
  const parsed = safeParse(localStorage.getItem(LEGACY_ALIASES_KEY))
  if (Object.keys(parsed).length === 0) return
  const builtinSet = new Set(builtinModelKeys().map((k) => k.toLowerCase()))
  const newMarks: MarkMap = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string' || !v.trim()) continue
    const norm = v.toLowerCase().trim()
    if (builtinSet.has(norm)) {
      newMarks[k] = v
    }
    // 自由命名直接丢（它们本来就是"显示用的"，不参与计价）
  }
  if (Object.keys(newMarks).length > 0) saveMarks(newMarks)
}

// ---------- hooks ----------

/** 订阅 marks 变更。返回当前值。 */
export function useMarks(): MarkMap {
  const [marks, setLocal] = useState<MarkMap>(() => {
    const m = loadMarks()
    setMarks(m)
    return m
  })
  useEffect(() => {
    const cb = (): void => {
      const next = loadMarks()
      setLocal(next)
      setMarks(next)
    }
    listeners.add(cb)
    const onStorage = (ev: StorageEvent): void => {
      if (ev.key === MARKS_KEY || ev.key === CUSTOM_KEY) cb()
    }
    window.addEventListener('storage', onStorage)
    return () => {
      listeners.delete(cb)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return marks
}

/** 订阅 custom models 变更。 */
export function useCustomModels(): CustomModelMap {
  const [custom, setLocal] = useState<CustomModelMap>(() => {
    const c = loadCustomModels()
    setCustomModels(c)
    migrateLegacyAliases(loadMarks(), c)
    return c
  })
  useEffect(() => {
    const cb = (): void => {
      const next = loadCustomModels()
      setLocal(next)
      setCustomModels(next)
    }
    listeners.add(cb)
    const onStorage = (ev: StorageEvent): void => {
      if (ev.key === CUSTOM_KEY || ev.key === MARKS_KEY) cb()
    }
    window.addEventListener('storage', onStorage)
    return () => {
      listeners.delete(cb)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return custom
}

/** 给 useQuery 当 key 后缀的稳定签名。 */
export function marksSignature(marks: MarkMap, custom: CustomModelMap): string {
  const mk = Object.keys(marks).sort()
  const ck = Object.keys(custom).sort()
  if (mk.length === 0 && ck.length === 0) return '-'
  const mObj: MarkMap = {}
  for (const k of mk) mObj[k] = marks[k]!
  const cObj: CustomModelMap = {}
  for (const k of ck) cObj[k] = custom[k]!
  return JSON.stringify({ m: mObj, c: cObj })
}

// ---------- 分组 / 合并 ----------

/** 'openrouter/deepseek/deepseek-v4' → 'deepseek-v4'（仅切 provider 前缀） */
export function normalizeModelName(modelId: string): string {
  const slash = modelId.lastIndexOf('/')
  const base = slash >= 0 ? modelId.slice(slash + 1) : modelId
  return base.trim() || modelId
}

/**
 * 内置别名表查表：命中返回映射后的 id；不命中返回 null。
 * 与 normalizeModelName 拆开 — 避免污染纯切尾段的 utility。
 *
 * 与 pricing.BUILTIN_ALIASES_LC 保持同源（任一处新增都需要同步另一处）。
 * 提供多 key 同映射：覆盖带 / 不带 provider 前缀的同模型路由。
 */
export function applyBuiltin(modelId: string): string | null {
  const BUILTIN_ALIASES_LC: Record<string, string> = {
    'openrouter/sonoma/stealth/ox-alpha': 'GLM-5.3-Flash',
    'openrouter/sonoma/stealth/ox': 'GLM-5.3-Flash',
    'openrouter/sonoma/stealth': 'GLM-5.3-Flash',
    'sonoma/stealth/ox-alpha': 'GLM-5.3-Flash',
    'sonoma/stealth/ox': 'GLM-5.3-Flash',
    'sonoma/stealth': 'GLM-5.3-Flash',
    'stealth/ox-alpha': 'GLM-5.3-Flash',
    'stealth/ox': 'GLM-5.3-Flash',
    'stealth': 'GLM-5.3-Flash',
    'minimax/minimax-m3:free': 'minimax-m3',
    'minimax-m3:free': 'minimax-m3',
    'deepseek-latest': 'deepseek-v4-flash',
    'deepseek-latest:free': 'deepseek-v4-flash',
    'cursor-grok-4.6-high': 'grok-4.6',
  }
  return BUILTIN_ALIASES_LC[modelId.toLowerCase()] ?? null
}

/** 一个 model_id 最终归入的分组键。 */
export function resolveGroupKey(modelId: string, mode: GroupMode, marks: MarkMap): string {
  // 标记优先：标记值就是合并键
  const marked = marks[modelId]
  if (marked && marked.trim()) return marked.trim()
  if (mode === 'name') {
    const builtin = applyBuiltin(modelId)
    if (builtin) return builtin
    return normalizeModelName(modelId)
  }
  return modelId
}

export type GroupedModelRow = TimingAggregates & {
  /** 分组键（按 ID 模式=原始 id；按名字模式=归一化名/标记值） */
  groupKey: string
  /** 表格首列主标题：识别出的内置模型走价目表 key 形式（如 "minimax-m3"），未识别回退 groupKey */
  displayName: string
  /** 该组包含的全部 model_id（详情页查询用 + 副行展示） */
  modelIds: string[]
  /** 是否合并了多个 id */
  merged: boolean
  /** 组内至少一个 id 有用户标记（用于 UI 标签） */
  marked: boolean
  calls: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  errorCount: number
  cacheHitRate: number
  share: number
  /** ¥ 估算成本（per-id 计价后求和；pricing 已感知 marks） */
  cost: number
  /** 该组里至少有一个底层 model_id 被价目表 / 标记 / 自定义模型识别 */
  recognized: boolean
}

/** 把按 model_id+provider 聚合的行合并成分组行，按总 token 降序。 */
/** 把 ByProviderModelRow[] 转成 ByModelRow[] 后按模型名分组。
 * 用于「供应商详情页」：同一 provider 下把不同 raw model_id 按名字聚合。 */
export function resolveProviderModelGroups(
  rows: readonly ByProviderModelRow[],
  mode: GroupMode,
  marks: MarkMap,
): GroupedModelRow[] {
  const mapped: ByModelRow[] = rows.map((r) => ({ ...r }))
  return resolveGroups(mapped, mode, marks)
}

export function resolveGroups(
  rows: readonly ByModelRow[],
  mode: GroupMode,
  marks: MarkMap,
): GroupedModelRow[] {
  const byKey = new Map<string, GroupedModelRow>()
  let grandTotal = 0
  for (const r of rows) grandTotal += r.totalTokens
  for (const r of rows) {
    const id = r.modelId
    const key = resolveGroupKey(id, mode, marks)
    let g = byKey.get(key)
    if (!g) {
      g = {
        groupKey: key,
        displayName: key,
        modelIds: [],
        merged: false,
        marked: false,
        calls: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        errorCount: 0,
        cacheHitRate: 0,
        share: 0,
        cost: 0,
        recognized: false,
        speedOutputTokens: 0,
        speedDurationMs: 0,
        speedSampleCount: 0,
        ttftSumMs: 0,
        ttftSampleCount: 0,
        totalDurationMs: 0,
        avgOutputSpeed: null,
        avgTtftMs: null,
        avgDurationMs: null,
      }
      byKey.set(key, g)
    }
    if (!g.modelIds.includes(id)) g.modelIds.push(id)
    if (marks[id]) g.marked = true
    if (isRecognizedModel(id)) g.recognized = true
    g.calls += r.calls
    g.totalTokens += r.totalTokens
    g.inputTokens += r.inputTokens
    g.outputTokens += r.outputTokens
    g.reasoningTokens += r.reasoningTokens
    g.cacheReadTokens += r.cacheReadTokens
    g.cacheCreationTokens += r.cacheCreationTokens
    g.errorCount += r.errorCount
    g.speedOutputTokens += r.speedOutputTokens
    g.speedDurationMs += r.speedDurationMs
    g.speedSampleCount += r.speedSampleCount
    g.ttftSumMs += r.ttftSumMs
    g.ttftSampleCount += r.ttftSampleCount
    g.totalDurationMs += r.totalDurationMs
    // 成本：按底层 model_id 各自计价；pricing 已感知 marks
    g.cost += costFor(id, r)
  }
  const out = [...byKey.values()]
  for (const g of out) {
    g.merged = g.modelIds.length > 1
    const denom = g.inputTokens + g.cacheCreationTokens
    g.cacheHitRate = denom > 0 ? g.cacheReadTokens / denom : 0
    g.share = grandTotal > 0 ? g.totalTokens / grandTotal : 0
    g.avgOutputSpeed = g.speedDurationMs > 0 ? (g.speedOutputTokens / g.speedDurationMs) * 1000 : null
    g.avgTtftMs = g.ttftSampleCount > 0 ? g.ttftSumMs / g.ttftSampleCount : null
    g.avgDurationMs = g.speedSampleCount > 0 ? g.totalDurationMs / g.speedSampleCount : null
    // 展示主标题：识别出的组用价目表 key 的可读名（如 "MiniMax M3"），未识别回退到 groupKey
    if (g.recognized) {
      const firstId = g.modelIds[0] ?? g.groupKey
      // 优先用 applyBuiltin 拿价目表 key（更稳），否则走 resolveMatch 拿到 matched
      const builtin = applyBuiltin(firstId)
      let key: string
      if (builtin) {
        key = builtin
      } else {
        const m = resolveMatch(firstId)
        // rule==='default' 意味着落到兜底价，不算"真"识别
        key = m.rule === 'default' ? g.groupKey : m.matched
      }
      g.displayName = displayNameOf(key)
    } else {
      g.displayName = g.groupKey
    }
  }
  out.sort((a, b) => b.totalTokens - a.totalTokens)
  return out
}

// 多模型分线趋势图的循环调色板（iOS 系柔和色，与现有图表主色一致）
export const MODEL_LINE_COLORS = [
  '#1f6ec7', // 蓝
  '#34c759', // 绿
  '#8e6cc7', // 紫
  '#e07a3a', // 橙
  '#e04545', // 红
  '#30b0c7', // 青
  '#5e5ce6', // 靛
  '#e0669e', // 粉
  '#a2845e', // 棕
  '#8e8e93', // 灰
] as const
