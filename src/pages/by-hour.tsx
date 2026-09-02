import { useState } from 'preact/hooks'
import { HeatmapGrid, type HeatmapCell } from '../ui/heatmap-grid.tsx'
import { SegmentedControl } from '../ui/segmented-control.tsx'
import { RangeSelectorTabs, RangeSelectorPanelForBelow, useRangeSelectorState } from '../ui/range-selector.tsx'
import { useQuery } from '../lib/use-query.ts'
import { QUERIES, rangeSignature, shapeByHour } from '../db/queries.ts'
import type { OpenedDb } from '../db/client.ts'
import type { ByHourGrid as ByHourGridT } from '../db/types.ts'
import { useRange } from '../lib/range-context.tsx'
import { formatDuration, formatTokensPerSecond } from '../lib/format.ts'

type Metric = 'tokens' | 'speed' | 'ttft'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))

export function ByHourPage({ db }: { db: OpenedDb }) {
  const { range, setPreset, setCustom } = useRange()
  const rs = useRangeSelectorState({ value: range, onPreset: setPreset, onCustom: setCustom })
  const [metric, setMetric] = useState<Metric>('tokens')
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
          <p class="page__subtitle">一周 × 24 小时，切换指标查看不同维度热度</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <SegmentedControl<Metric>
            value={metric}
            onChange={setMetric}
            ariaLabel="指标"
            items={[
              { id: 'tokens', label: 'Token' },
              { id: 'speed', label: '速度' },
              { id: 'ttft', label: 'TTFT' },
            ]}
          />
          <RangeSelectorTabs state={rs} ariaLabel="时间范围" />
        </div>
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
            cells={buildCells(state.data, metric)}
            tooltip={(c) => {
              const base = `周${WEEKDAYS[c.row]} ${HOURS[c.col]}:00`
              if (metric === 'speed') {
                return `${base} · ${c.value > 0 ? formatTokensPerSecond(c.value) : '—'} · ${c.label ?? ''} 次样本`
              }
              if (metric === 'ttft') {
                return `${base} · ${c.value > 0 ? formatDuration(c.value) : '—'} · ${c.label ?? ''} 次样本`
              }
              return `${base} · ${c.value} token · ${c.label ?? ''} 次调用`
            }}
          />
        )}
      </div>
    </div>
  )
}

function buildCells(g: ByHourGridT, metric: Metric): HeatmapCell[] {
  // SQLite strftime('%w') returns 0..6 starting Sunday
  return g.cells.map((c) => {
    if (metric === 'speed') {
      return {
        row: c.weekday,
        col: c.hour,
        value: c.speedDurationMs > 0 ? (c.speedOutputTokens / c.speedDurationMs) * 1000 : 0,
        label: c.speedSampleCount > 0 ? String(c.speedSampleCount) : '',
      }
    }
    if (metric === 'ttft') {
      return {
        row: c.weekday,
        col: c.hour,
        value: c.ttftSampleCount > 0 ? c.ttftSumMs / c.ttftSampleCount : 0,
        label: c.ttftSampleCount > 0 ? String(c.ttftSampleCount) : '',
      }
    }
    return {
      row: c.weekday,
      col: c.hour,
      value: c.totalTokens,
      label: c.calls > 0 ? String(c.calls) : '',
    }
  })
}
