import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
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
  const rootRef = useRef<HTMLDivElement | null>(null)
  // thumb 按激活项实测几何（段宽随文字自然变化，不等分），null 时走 CSS 等分兜底
  const [thumb, setThumb] = useState<{ w: number; x: number } | null>(null)
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === value),
  )

  useEffect(() => {
    const frame = requestAnimationFrame(() => setMotionReady(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const measure = () => {
      const el = root.querySelectorAll<HTMLButtonElement>('.segmented-control__item')[activeIndex]
      if (!el) return
      const w = el.offsetWidth
      const x = el.offsetLeft - root.clientLeft
      setThumb((prev) => (prev && prev.w === w && prev.x === x ? prev : { w, x }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(root)
    return () => ro.disconnect()
  }, [activeIndex, items])

  const rootClass = [
    'segmented-control',
    motionReady ? 'segmented-control--ready' : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      ref={rootRef}
      class={rootClass}
      role="tablist"
      aria-label={ariaLabel}
      style={{
        '--segmented-count': String(Math.max(items.length, 1)),
        '--segmented-index': String(activeIndex),
      }}
    >
      <span
        class="segmented-control__thumb"
        aria-hidden="true"
        style={thumb ? { width: `${thumb.w}px`, transform: `translateX(${thumb.x}px)` } : undefined}
      />
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
