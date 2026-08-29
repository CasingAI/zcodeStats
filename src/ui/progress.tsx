import type { ComponentChildren } from 'preact'
import './progress.css'

export type ProgressStatus = 'normal' | 'active' | 'success' | 'error'

type ProgressProps = {
  /** 0-100 的百分比；< 0 或 > 100 会被 clamp */
  percent: number
  /** 状态：active 显示条纹动画，success 绿色，error 红 */
  status?: ProgressStatus
  /** 控制条高度 */
  size?: 'small' | 'default'
  /** 是否显示右上角百分比文本 */
  showInfo?: boolean
  /** 追加自定义类名 */
  className?: string
  /** 覆盖内联渲染的百分比文案（如 "12 / 340"） */
  info?: string
  /** 无障碍 label */
  ariaLabel?: string
  children?: ComponentChildren
}

function clampPercent(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.max(0, Math.min(100, value))
}

export function Progress({
  percent,
  status = 'normal',
  size = 'default',
  showInfo = true,
  className,
  info,
  ariaLabel,
  children,
}: ProgressProps) {
  const clamped = clampPercent(percent)
  const displayText = info ?? `${Math.round(clamped)}%`
  const statusClass =
    status === 'success'
      ? ' progress--success'
      : status === 'error'
        ? ' progress--error'
        : status === 'active'
          ? ' progress--active'
          : ''
  const sizeClass = size === 'small' ? ' progress--small' : ''
  const extraClass = className ? ` ${className}` : ''

  return (
    <div
      class={`progress${statusClass}${sizeClass}${extraClass}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      aria-label={ariaLabel}
    >
      <div class="progress__track">
        <div class="progress__bar" style={{ width: `${clamped}%` }}>
          {children}
        </div>
      </div>
      {showInfo && <span class="progress__info">{displayText}</span>}
    </div>
  )
}
