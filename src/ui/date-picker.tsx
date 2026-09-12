// 轻量日期 + 时间选择控件（分钟精度）。
//
// 设计目标：
//   - 不依赖 dayjs/date-fns；用原生 Date + ms epoch 即可。
//   - max 钳制到调用方给的范围（用户业务是"看过去的用量"），min 不限制（schema 范围外也允许）
//   - iOS 风格：套 ios-text-field 视觉；左右 ±1 天箭头 + 快捷按钮（"今天"或"现在"）。
//   - 用原生 <input type="datetime-local">，浏览器内建日历 + 时间选择，无需自己实现。
//
// 注意：原生 <input type="datetime-local"> 在某些浏览器上 min/max 钳制只在弹层 UI 里生效，
// 手动键入仍可能越过；onChange 之后我们重新写回 value 强制约束。

import { useMemo } from 'preact/hooks'
import './date-picker.css'

const MS_PER_DAY = 86_400_000

function startOfDayMs(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime()
}

function toIsoDateTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function fromIsoDateTime(s: string): number | null {
  // s = "YYYY-MM-DDTHH:mm"，按本地时区解释
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const h = Number(m[4])
  const mi = Number(m[5])
  if (!y || !mo || !d) return null
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
}

function clampMs(v: number, minMs: number, maxMs: number): number {
  if (v < minMs) return minMs
  if (v > maxMs) return maxMs
  return v
}

export type DatePickerProps = {
  /** 当前值（ms epoch，分钟精度） */
  value: number
  onChange: (ms: number) => void
  /** 标签文字（例："从" / "到"） */
  label?: string
  /** 最小可选时刻（ms epoch） */
  minMs?: number
  /** 最大可选时刻（ms epoch） */
  maxMs?: number
  /** 快捷按钮：'today' 设为当日 00:00（默认）；'now' 设为当前时刻 */
  quick?: 'today' | 'now'
  /** 用于关联的 id（无障碍） */
  id?: string
}

export function DatePicker({ value, onChange, label, minMs, maxMs, quick = 'today', id }: DatePickerProps) {
  const min = minMs ?? Number.NEGATIVE_INFINITY
  const max = maxMs ?? Number.POSITIVE_INFINITY
  const iso = toIsoDateTime(value)
  const minIso = Number.isFinite(min) ? toIsoDateTime(min) : undefined
  const maxIso = Number.isFinite(max) ? toIsoDateTime(max) : undefined
  const { todayMs, nowMs } = useMemo(() => {
    const now = new Date()
    return { todayMs: startOfDayMs(now), nowMs: now.getTime() }
  }, [])
  const quickMs = quick === 'now' ? Math.floor(nowMs / 60_000) * 60_000 : todayMs
  const quickLabel = quick === 'now' ? '现在' : '今天'

  const handleInput = (nextIso: string) => {
    const parsed = fromIsoDateTime(nextIso)
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
          type="datetime-local"
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
          onClick={() => onChange(clampMs(quickMs, min, max))}
          disabled={value === quickMs}
        >
          {quickLabel}
        </button>
      </div>
    </div>
  )
}
