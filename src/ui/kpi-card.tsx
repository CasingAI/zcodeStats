import type { ComponentChildren } from 'preact'
import './kpi-card.css'

export type KpiCardTone = 'default' | 'blue' | 'green' | 'orange' | 'red' | 'purple'

export type KpiCardProps = {
  label: string
  value: ComponentChildren
  /** 副标题（指标说明或对比基线） */
  sub?: ComponentChildren
  /** 右上角小标签，比如 "↗ 12%" "本周" */
  badge?: ComponentChildren
  tone?: KpiCardTone
  /** 加载中：显示灰底 + 浅灰条 */
  loading?: boolean
  className?: string
}

export function KpiCard({
  label,
  value,
  sub,
  badge,
  tone = 'default',
  loading = false,
  className,
}: KpiCardProps) {
  const toneClass = tone === 'default' ? '' : ` kpi-card--${tone}`
  return (
    <div class={`kpi-card${toneClass}${className ? ` ${className}` : ''}`}>
      <div class="kpi-card__row">
        <div class="kpi-card__label">{label}</div>
        {badge && <div class="kpi-card__badge">{badge}</div>}
      </div>
      {loading ? (
        <div class="kpi-card__skeleton" aria-hidden="true" />
      ) : (
        <div class="kpi-card__value">{value}</div>
      )}
      {sub && <div class="kpi-card__sub">{sub}</div>}
    </div>
  )
}
