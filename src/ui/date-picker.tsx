// 轻量单日选择控件。
//
// 设计目标：
//   - 不依赖 dayjs/date-fns；用原生 Date + ms epoch 即可。
//   - max 钳制到今天（用户业务是"看过去的用量"），min 不限制（schema 范围外也允许）
//   - iOS 风格：套 ios-text-field 视觉；左右 ±1 天箭头 + "今天"快捷键。
//   - 用原生 <input type="date">，因为浏览器在所有目标浏览器都内建日历，无需自己实现 grid。
//
// 注意：原生 <input type="date"> 在某些浏览器上 min/max 钳制只在日历 UI 里生效，
// 手动键入仍可能越过；onChange 之后我们重新写回 value 强制约束。

import { useMemo } from 'preact/hooks'
import './date-picker.css'

const MS_PER_DAY = 86_400_000

function startOfDayMs(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime()
}

function toIsoDate(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fromIsoDate(s: string): number | null {
  // s = "YYYY-MM-DD"，按本地时区解释为当天 00:00
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (!y || !mo || !d) return null
  return new Date(y, mo - 1, d, 0, 0, 0, 0).getTime()
}

function clampMs(v: number, minMs: number, maxMs: number): number {
  if (v < minMs) return minMs
  if (v > maxMs) return maxMs
  return v
}

export type DatePickerProps = {
  /** 当前值（ms epoch，按本地时区的当天 00:00） */
  value: number
  onChange: (ms: number) => void
  /** 标签文字（例："从" / "到"） */
  label?: string
  /** 最小可选日期（ms epoch） */
  minMs?: number
  /** 最大可选日期（ms epoch） */
  maxMs?: number
  /** 用于关联的 id（无障碍） */
  id?: string
}

export function DatePicker({ value, onChange, label, minMs, maxMs, id }: DatePickerProps) {
  const min = minMs ?? Number.NEGATIVE_INFINITY
  const max = maxMs ?? Number.POSITIVE_INFINITY
  const iso = toIsoDate(value)
  const minIso = Number.isFinite(min) ? toIsoDate(min) : undefined
  const maxIso = Number.isFinite(max) ? toIsoDate(max) : undefined
  const todayMs = useMemo(() => startOfDayMs(new Date()), [])

  const handleInput = (nextIso: string) => {
    const parsed = fromIsoDate(nextIso)
    if (parsed === null) return
    const clamped = clampMs(parsed, min, max)
    if (clamped !== value) onChange(clamped)
  }

  const shift = (deltaDays: number) => {
    const next = value + deltaDays * MS_PER_DAY
    const clamped = clampMs(next, min, max)
    if (clamped !== value) onChange(clamped)
  }

  return (
    <div class="date-picker">
      {label && <label class="date-picker__label" for={id}>{label}</label>}
      <div class="date-picker__row">
        <button
          type="button"
          class="date-picker__step"
          aria-label="前一天"
          onClick={() => shift(-1)}
          disabled={value <= min}
        >
          ‹
        </button>
        <input
          id={id}
          class="date-picker__input ios-text-field"
          type="date"
          value={iso}
          min={minIso}
          max={maxIso}
          onInput={(e) => handleInput((e.currentTarget as HTMLInputElement).value)}
        />
        <button
          type="button"
          class="date-picker__step"
          aria-label="后一天"
          onClick={() => shift(1)}
          disabled={value >= max}
        >
          ›
        </button>
        <button
          type="button"
          class="date-picker__today"
          onClick={() => onChange(todayMs)}
          disabled={value === todayMs}
        >
          今天
        </button>
      </div>
    </div>
  )
}
