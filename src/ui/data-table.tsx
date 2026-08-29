import type { ComponentChildren, JSX } from 'preact'
import './data-table.css'

export type DataTableColumn<Row> = {
  key: string
  /** 列头文案 */
  header: string
  /** 对齐 */
  align?: 'left' | 'right' | 'center'
  /** 文本宽度提示（CSS 值，如 '120px' / '1fr'） */
  width?: string
  /** 该列是否参与 flex 布局（默认 true） */
  flex?: boolean
  /** 自定义渲染 */
  render: (row: Row, index: number) => ComponentChildren
}

export type DataTableProps<Row> = {
  columns: readonly DataTableColumn<Row>[]
  rows: readonly Row[]
  /** 唯一 key（用于 React 风格 list key） */
  rowKey: (row: Row, index: number) => string | number
  loading?: boolean
  emptyMessage?: string
  /** 紧凑行高 */
  compact?: boolean
  className?: string
  /** 行点击（传入后行显示为可点击样式） */
  onRowClick?: (row: Row, index: number) => void
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  loading = false,
  emptyMessage = '没有数据',
  compact = false,
  className,
  onRowClick,
}: DataTableProps<Row>) {
  const wrapClass = `data-table${className ? ` ${className}` : ''}${compact ? ' data-table--compact' : ''}`

  if (loading) {
    return (
      <div class={wrapClass} aria-busy="true">
        <div class="data-table__loading">加载中…</div>
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div class={wrapClass}>
        <div class="data-table__empty">{emptyMessage}</div>
      </div>
    )
  }

  // Compute template columns from `width` / `flex` hints.
  const template = columns
    .map((c) => {
      if (c.width) return c.width
      if (c.flex === false) return 'auto'
      return 'minmax(0, 1fr)'
    })
    .join(' ')

  const headerStyle: JSX.CSSProperties = { 'grid-template-columns': template }
  const rowStyle: JSX.CSSProperties = { 'grid-template-columns': template }

  return (
    <div class={wrapClass} role="table" aria-rowcount={rows.length + 1}>
      <div class="data-table__header" role="row" style={headerStyle}>
        {columns.map((c) => (
          <div
            key={c.key}
            class="data-table__cell data-table__cell--head"
            role="columnheader"
            data-align={c.align ?? 'left'}
          >
            {c.header}
          </div>
        ))}
      </div>
      <div class="data-table__body">
        {rows.map((row, i) => (
          <div
            key={rowKey(row, i)}
            class={`data-table__row${onRowClick ? ' data-table__row--clickable' : ''}`}
            role="row"
            style={rowStyle}
            onClick={onRowClick ? () => onRowClick(row, i) : undefined}
          >
            {columns.map((c) => (
              <div
                key={c.key}
                class="data-table__cell"
                role="cell"
                data-align={c.align ?? 'left'}
              >
                {c.render(row, i)}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
