// 全局共享的时间范围 state。
//
// 设计：
//   - Range 现在是判别联合（preset 或 custom 区间）。
//   - 单一 source of truth：包在 App 外，所有 6 个分析页通过 useRange() 读写。
//   - 持久化：localStorage 键 'zcode-stats.range'；跨 tab 通过 storage 事件同步。
//   - 默认 { kind: 'preset', preset: '30d' }，与页面历史默认一致。
//
// 范围值进入 SQL 时由 queries.ts 的 rangeClause 翻译成 started_at 谓词。

import { createContext } from 'preact'
import { useContext, useEffect, useState, useCallback } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { DEFAULT_RANGE, type Range, type RangePreset } from '../db/queries.ts'

const STORAGE_KEY = 'zcode-stats.range'

type RangeContextValue = {
  range: Range
  setPreset: (p: RangePreset) => void
  setCustom: (from: number, to: number) => void
  resetToDefault: () => void
}

const RangeContext = createContext<RangeContextValue | null>(null)

function safeParse(raw: string | null): Range | null {
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object') return null
    const o = v as Record<string, unknown>
    if (o.kind === 'preset' && (o.preset === '7d' || o.preset === '30d' || o.preset === 'all')) {
      return { kind: 'preset', preset: o.preset }
    }
    if (o.kind === 'custom' && typeof o.from === 'number' && typeof o.to === 'number') {
      if (!Number.isFinite(o.from) || !Number.isFinite(o.to)) return null
      if (o.from >= o.to) return null
      return { kind: 'custom', from: o.from, to: o.to }
    }
  } catch {
    /* corrupted */
  }
  return null
}

function loadInitial(): Range {
  if (typeof localStorage === 'undefined') return DEFAULT_RANGE
  return safeParse(localStorage.getItem(STORAGE_KEY)) ?? DEFAULT_RANGE
}

function persist(range: Range): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(range))
  } catch {
    /* storage full / disabled */
  }
}

export function RangeProvider({ children }: { children: ComponentChildren }) {
  const [range, setRange] = useState<Range>(loadInitial)

  // 跨 tab 同步：另一个 tab 改了 localStorage 时跟过来
  useEffect(() => {
    const onStorage = (ev: StorageEvent): void => {
      if (ev.key !== STORAGE_KEY) return
      const next = safeParse(ev.newValue)
      if (next) setRange(next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setPreset = useCallback((p: RangePreset) => {
    setRange((cur) => {
      const next: Range = { kind: 'preset', preset: p }
      if (cur === next || (cur.kind === 'preset' && cur.preset === p)) return cur
      persist(next)
      return next
    })
  }, [])

  const setCustom = useCallback((from: number, to: number) => {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return
    setRange((cur) => {
      const next: Range = { kind: 'custom', from, to }
      if (cur === next) return cur
      persist(next)
      return next
    })
  }, [])

  const resetToDefault = useCallback(() => {
    setRange((cur) => {
      if (cur === DEFAULT_RANGE) return cur
      persist(DEFAULT_RANGE)
      return DEFAULT_RANGE
    })
  }, [])

  return (
    <RangeContext.Provider value={{ range, setPreset, setCustom, resetToDefault }}>
      {children}
    </RangeContext.Provider>
  )
}

export function useRange(): RangeContextValue {
  const ctx = useContext(RangeContext)
  if (!ctx) throw new Error('useRange must be used within <RangeProvider>')
  return ctx
}
