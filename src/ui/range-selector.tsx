// 顶部时间范围选择器。
//
// 拆成两个独立组件：RangeSelectorTabs 和 RangeSelectorCustomPanel。
// 拆出来的原因：custom 面板需要作为 section__header 的"下一行"独立显示，
// 而不是嵌在 tab 容器内部被压窄。
//
// 行为：
//   - 5 个 tab：近 30 分钟 / 近 7 天 / 近 30 天 / 全部 / 自定义
//   - 选前 4 个时通过 onPreset(p) 回调，外部把 range 写成 { kind:'preset', preset }
//   - 选"自定义"时切换到 custom tab，此时 RangeSelectorCustomPanel 显示
//     两个 <DatePicker>（从 / 到，日期+时间到分钟） + 应用/重置 按钮
//   - 内部用本地 activeTab state 跟踪用户当前停在哪个 tab；
//     value 改变时（外部或跨 tab 同步）activeTab 自动跟随。
//   - 共享同一份 draftFrom / draftTo state，封装在 useRangeSelectorDraft hook 里。
//     draft 为精确时刻（ms），「应用」原样提交（to 为开区间端点）。

import { useEffect, useState } from 'preact/hooks'
import { SegmentedControl } from './segmented-control.tsx'
import { IosButton } from './ios-button.tsx'
import { DatePicker } from './date-picker.tsx'
import type { Range, RangePreset } from '../db/queries.ts'
import './range-selector.css'

const MS_PER_HOUR = 3600 * 1000

/** "MM-DD HH:mm"（customRangeLabel 用，年份通常无歧义故省略） */
function toLabelDateTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 当天 23:59:59.999（「到」的上限，允许选满今天） */
function endOfTodayMs(): number {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime()
}

type TabId = 'preset:30m' | 'preset:7d' | 'preset:30d' | 'preset:all' | 'custom'

function currentTab(r: Range): TabId {
  if (r.kind === 'custom') return 'custom'
  return `preset:${r.preset}` as TabId
}

/**
 * 共享的 draft 状态：tab 和 custom 面板都基于这份草稿渲染。
 * - 首次进入"自定义"tab：草稿为「现在 - 30 天 → 现在」
 * - 外部 value 是 custom：草稿跟随 value
 * - 点"应用"才提交，期间修改不污染父 range
 */
export type RangeSelectorDraft = {
  nowMs: number
  draftFrom: number
  draftTo: number
  setDraftFrom: (ms: number) => void
  setDraftTo: (ms: number) => void
}

function defaultDraft(): { from: number; to: number } {
  const now = Date.now()
  return { from: now - 30 * 24 * MS_PER_HOUR, to: now }
}

export function useRangeSelectorDraft(value: Range): RangeSelectorDraft {
  const [nowMs] = useState<number>(() => Date.now())
  const [draftFrom, setDraftFrom] = useState<number>(() => {
    if (value.kind === 'custom') return value.from
    return defaultDraft().from
  })
  const [draftTo, setDraftTo] = useState<number>(() => {
    if (value.kind === 'custom') return value.to
    return defaultDraft().to
  })

  useEffect(() => {
    if (value.kind === 'custom') {
      setDraftFrom(value.from)
      setDraftTo(value.to)
    }
  }, [value])

  return { nowMs, draftFrom, draftTo, setDraftFrom, setDraftTo }
}

export type RangeSelectorCustomPanelProps = {
  visible: boolean
  draft: RangeSelectorDraft
  onCustom: (from: number, to: number) => void
  onReset: () => void
  className?: string
}

export function RangeSelectorCustomPanel({
  visible,
  draft,
  onCustom,
  onReset,
  className,
}: RangeSelectorCustomPanelProps) {
  if (!visible) return null

  const { draftFrom, draftTo, setDraftFrom, setDraftTo } = draft

  const apply = () => {
    onCustom(draftFrom, draftTo)
  }

  return (
    <div class={`range-selector__custom ${className ?? ''}`.trim()}>
      <DatePicker
        id="range-selector__from"
        label="从"
        value={draftFrom}
        onChange={setDraftFrom}
        maxMs={draftTo}
      />
      <DatePicker
        id="range-selector__to"
        label="到"
        value={draftTo}
        onChange={setDraftTo}
        minMs={draftFrom}
        maxMs={endOfTodayMs()}
        quick="now"
      />
      <IosButton tone="primary" size="compact" onClick={apply} disabled={draftFrom >= draftTo}>
        应用
      </IosButton>
      <IosButton tone="secondary" size="compact" onClick={onReset}>
        重置
      </IosButton>
    </div>
  )
}

/**
 * 把 RangeSelector 的状态（activeTab + 草稿）抽成 useRangeSelectorState hook，
 * 让 tab 和 custom 面板可以独立渲染在 DOM 树的不同位置。
 *
 * 用法：
 *   const rs = useRangeSelectorState({ value, onPreset, onCustom })
 *   <RangeSelectorTabs state={rs} />     // 渲染在 section__header 内
 *   <RangeSelectorCustomPanel state={rs} />  // 渲染在 section__header 之外、section 之内
 */
export type RangeSelectorState = {
  value: Range
  onPreset: (p: RangePreset) => void
  onCustom: (from: number, to: number) => void
  draft: RangeSelectorDraft
  activeTab: TabId
  setActiveTab: (id: TabId) => void
  showCustom: boolean
  customRangeLabel: string | null
  reset: () => void
}

export function useRangeSelectorState(props: {
  value: Range
  onPreset: (p: RangePreset) => void
  onCustom: (from: number, to: number) => void
}): RangeSelectorState {
  const { value, onPreset, onCustom } = props
  const [activeTab, setActiveTab] = useState<TabId>(currentTab(value))
  const draft = useRangeSelectorDraft(value)

  useEffect(() => {
    setActiveTab(currentTab(value))
  }, [value])

  const reset = () => {
    const d = defaultDraft()
    draft.setDraftFrom(d.from)
    draft.setDraftTo(d.to)
    onPreset('30d')
  }

  const showCustom = activeTab === 'custom'
  const customRangeLabel =
    value.kind === 'custom'
      ? `${toLabelDateTime(value.from)} → ${toLabelDateTime(value.to)}`
      : null

  return { value, onPreset, onCustom, draft, activeTab, setActiveTab, showCustom, customRangeLabel, reset }
}

/**
 * 仅渲染 tab 容器（4 个 tab）。放在 section__header 内。
 */
export type RangeSelectorTabsOnlyProps = {
  state: RangeSelectorState
  ariaLabel?: string
  className?: string
}

export function RangeSelectorTabs({ state, ariaLabel, className }: RangeSelectorTabsOnlyProps) {
  const { activeTab, setActiveTab, value, draft, onPreset } = state

  const handleTab = (id: TabId) => {
    setActiveTab(id)
    if (id === 'custom') {
      if (value.kind !== 'custom') {
        const d = defaultDraft()
        draft.setDraftFrom(d.from)
        draft.setDraftTo(d.to)
      }
      return
    }
    const preset = id.slice('preset:'.length) as RangePreset
    onPreset(preset)
  }

  return (
    <div class={`range-selector__tabs ${className ?? ''}`.trim()}>
      <SegmentedControl<TabId>
        value={activeTab}
        onChange={handleTab}
        ariaLabel={ariaLabel ?? '时间范围'}
        items={[
          { id: 'preset:30m', label: '近30分钟' },
          { id: 'preset:7d', label: '近7天' },
          { id: 'preset:30d', label: '近30天' },
          { id: 'preset:all', label: '全部' },
          { id: 'custom', label: '自定义' },
        ]}
      />
    </div>
  )
}

/**
 * 仅渲染 custom 面板 / 当前自定义提示，外层包一个 .range-selector__subheader 容器
 * 跟 .section__header 语义对应。放在 section__header 之外、section 之内的兄弟位置。
 *
 * 如果两个分支都不显示（既没展开 custom，也不是 custom range），整个 subheader 容器
 * 也不渲染（返回 null），不影响布局。
 */
export function RangeSelectorPanelForBelow({ state }: { state: RangeSelectorState }) {
  const { showCustom, customRangeLabel, draft, onCustom, reset } = state
  if (showCustom) {
    return (
      <div class="range-selector__subheader">
        <RangeSelectorCustomPanel visible draft={draft} onCustom={onCustom} onReset={reset} />
      </div>
    )
  }
  if (customRangeLabel) {
    return (
      <div class="range-selector__subheader">
        <div class="range-selector__current">当前自定义：{customRangeLabel}</div>
      </div>
    )
  }
  return null
}

/**
 * 兼容旧 API：返回单根 div，内部 column 排 tab + custom。
 * 等价于把 RangeSelectorTabs + RangeSelectorPanelForBelow 套到同一个 div 里。
 */
export type RangeSelectorProps = {
  value: Range
  onPreset: (p: RangePreset) => void
  onCustom: (from: number, to: number) => void
  ariaLabel?: string
  className?: string
}

export function RangeSelector({ value, onPreset, onCustom, ariaLabel, className }: RangeSelectorProps) {
  const state = useRangeSelectorState({ value, onPreset, onCustom })
  return (
    <div class={`range-selector ${className ?? ''}`.trim()}>
      <RangeSelectorTabs state={state} ariaLabel={ariaLabel} />
      <RangeSelectorPanelForBelow state={state} />
    </div>
  )
}
