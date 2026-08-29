import { useMemo } from 'preact/hooks'
import './heatmap-grid.css'

export type HeatmapCell = {
  /** 标签（行 0..n-1，列 0..m-1） */
  row: number
  col: number
  value: number
  /** 可选自定义标签，默认展示 value */
  label?: string
}

export type HeatmapGridProps = {
  rows: readonly string[]
  cols: readonly string[]
  cells: readonly HeatmapCell[]
  /** 颜色阶梯（深 → 浅，CSS 颜色值数组） */
  palette?: readonly string[]
  /** 自定义提示 */
  tooltip?: (cell: HeatmapCell) => string
  className?: string
}

const DEFAULT_PALETTE = [
  '#eef4ff',
  '#c8dcfb',
  '#93b8f5',
  '#5e8ee6',
  '#2f6ed1',
  '#1f55a8',
  '#143c7a',
]

function getCell(cells: readonly HeatmapCell[], row: number, col: number): HeatmapCell | undefined {
  return cells.find((c) => c.row === row && c.col === col)
}

export function HeatmapGrid({
  rows,
  cols,
  cells,
  palette = DEFAULT_PALETTE,
  tooltip,
  className,
}: HeatmapGridProps) {
  const max = useMemo(() => Math.max(1, ...cells.map((c) => c.value)), [cells])
  const min = useMemo(() => Math.min(0, ...cells.map((c) => c.value)), [cells])

  function colorFor(v: number): string {
    if (max === min) return palette[0]!
    const t = (v - min) / (max - min)
    const idx = Math.min(palette.length - 1, Math.floor(t * palette.length))
    return palette[idx]!
  }

  return (
    <div class={`heatmap-grid${className ? ` ${className}` : ''}`}>
      <div
        class="heatmap-grid__inner"
        style={{
          'grid-template-columns': `auto repeat(${cols.length}, minmax(0, 1fr))`,
          'grid-template-rows': `auto repeat(${rows.length}, minmax(22px, 1fr))`,
        }}
      >
        <div class="heatmap-grid__corner" />
        {cols.map((c, ci) => (
          <div key={`c-${ci}`} class="heatmap-grid__col-header">
            {c}
          </div>
        ))}
        {rows.map((r, ri) => (
          <>
            <div key={`r-${ri}`} class="heatmap-grid__row-header">
              {r}
            </div>
            {cols.map((_c, ci) => {
              const cell = getCell(cells, ri, ci)
              if (!cell) {
                return <div key={`empty-${ri}-${ci}`} class="heatmap-grid__cell heatmap-grid__cell--empty" />
              }
              return (
                <div
                  key={`cell-${ri}-${ci}`}
                  class="heatmap-grid__cell"
                  style={{ background: colorFor(cell.value) }}
                  title={tooltip ? tooltip(cell) : `${r} · ${cols[ci]}: ${cell.label ?? cell.value}`}
                >
                  {cell.label ?? ''}
                </div>
              )
            })}
          </>
        ))}
      </div>
    </div>
  )
}
