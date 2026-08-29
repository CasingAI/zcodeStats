import { HeatmapGrid, type HeatmapCell } from '../ui/heatmap-grid.tsx'
import { RangeSelectorTabs, RangeSelectorPanelForBelow, useRangeSelectorState } from '../ui/range-selector.tsx'
import { useQuery } from '../lib/use-query.ts'
import { QUERIES, rangeSignature, shapeByHour } from '../db/queries.ts'
import type { OpenedDb } from '../db/client.ts'
import type { ByHourGrid as ByHourGridT } from '../db/types.ts'
import { useRange } from '../lib/range-context.tsx'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))

export function ByHourPage({ db }: { db: OpenedDb }) {
  const { range, setPreset, setCustom } = useRange()
  const rs = useRangeSelectorState({ value: range, onPreset: setPreset, onCustom: setCustom })
  const state = useQuery<ByHourGridT>(db, `by-hour:${rangeSignature(range)}`, async (d) => {
    const q = QUERIES.byHour(range)
    const r = await d.select(q.sql, q.bind)
    return shapeByHour(r)
  })
  return (
    <div class="page">
      <div class="section__header">
        <div>
          <h1 class="page__title">按小时热力</h1>
          <p class="page__subtitle">一周 × 24 小时，色块越深 token 用量越多</p>
        </div>
        <RangeSelectorTabs state={rs} ariaLabel="时间范围" />
      </div>

      <RangeSelectorPanelForBelow state={rs} />

      <div class="section">
        {state.kind === 'loading' && <div class="app-banner">加载中…</div>}
        {state.kind === 'error' && <div class="app-banner app-banner--error">{state.error}</div>}
        {state.kind === 'ok' && state.data.cells.length === 0 && (
          <div class="app-banner">没有数据</div>
        )}
        {state.kind === 'ok' && state.data.cells.length > 0 && (
          <HeatmapGrid
            rows={WEEKDAYS}
            cols={HOURS}
            cells={buildCells(state.data)}
            tooltip={(c) => `周${WEEKDAYS[c.row]} ${HOURS[c.col]}:00 · ${c.value} token · ${c.label ?? ''} 次调用`}
          />
        )}
      </div>
    </div>
  )
}

function buildCells(g: ByHourGridT): HeatmapCell[] {
  // SQLite strftime('%w') returns 0..6 starting Sunday
  return g.cells.map((c) => ({
    row: c.weekday,
    col: c.hour,
    value: c.totalTokens,
    label: c.calls > 0 ? String(c.calls) : '',
  }))
}
