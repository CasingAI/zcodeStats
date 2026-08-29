import { useEffect, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import './segmented-control.css'

export type SegmentedControlItem<T extends string = string> = {
  id: T
  label: string
  /** 未选中时显示脏状态小橙点 */
  dirty?: boolean
  /** 段标签旁的数量角标；空字符串 / 0 / undefined 不显示 */
  badge?: string | number
}

export type SegmentedControlProps<T extends string = string> = {
  value: T
  items: readonly SegmentedControlItem<T>[]
  onChange: (id: T) => void
  ariaLabel: string
  className?: string
  children?: ComponentChildren
}

/** 凹槽条分段切换器；只管切换 UI，不管内容区 */
export function SegmentedControl<T extends string>({
  value,
  items,
  onChange,
  ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  const [motionReady, setMotionReady] = useState(false)
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === value),
  )

  useEffect(() => {
    const frame = requestAnimationFrame(() => setMotionReady(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  const rootClass = [
    'segmented-control',
    motionReady ? 'segmented-control--ready' : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      class={rootClass}
      role="tablist"
      aria-label={ariaLabel}
      style={{
        '--segmented-count': String(Math.max(items.length, 1)),
        '--segmented-index': String(activeIndex),
      }}
    >
      <span class="segmented-control__thumb" aria-hidden="true" />
      {items.map((item) => {
        const active = value === item.id
        const itemClass = [
          'segmented-control__item',
          active ? 'segmented-control__item--active' : undefined,
          item.dirty ? 'segmented-control__item--dirty' : undefined,
        ]
          .filter(Boolean)
          .join(' ')

        const showBadge =
          item.badge !== undefined && item.badge !== '' && item.badge !== 0

        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            class={itemClass}
            onClick={() => onChange(item.id)}
          >
            {item.label}
            {showBadge ? (
              <span class="segmented-control__badge">{item.badge}</span>
            ) : undefined}
          </button>
        )
      })}
    </div>
  )
}
