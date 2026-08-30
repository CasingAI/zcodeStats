// Thin Preact wrapper around uPlot. Handles instance lifecycle, container
// width tracking, and iOS 6-ish axis styling (无框选缩放，悬浮查看数值)。
// Callers pass plain arrays; uPlot owns the canvas rendering.
//
// 重建策略：format 引用 / series 数量 / x 轴类型 / 高 任意一项变化 → 销毁并重建。
// 仅 data 引用变化（同一 metric 切 range）→ 调 setData() 增量更新（避免闪烁）。
// 切换 metric 时 series 数量 + format 都变了 → 走重建路径，简单可靠。

import { useEffect, useRef } from 'preact/hooks'
import uPlot, { type AlignedData, type Options } from 'uplot'
import 'uplot/dist/uPlot.min.css'

export type UPlotChartProps = {
  /** data[0] = x 值（时间轴用 unix 秒，离散轴用序号），data[n] = 各 series 的 y */
  data: AlignedData
  /** uPlot series 配置（不含 index 0 的 x series，包装器自动补） */
  seriesDefs: {
    label: string
    stroke: string
    fill?: string | null
    width?: number
    /** 覆盖 series 级 value 格式化（tooltip / 图例） */
    value?: (self: uPlot, raw: uPlot, val: number | null) => string
    paths?: unknown
    points?: unknown
    spanGaps?: boolean
  }[]
  /** x 轴是否为时间轴（unix 秒）。false 时用离散数值轴。 */
  time?: boolean
  height?: number
  yFormat?: (v: number) => string
  xFormat?: (v: number) => string
  className?: string
}

const AXIS_FONT = '10px -apple-system, BlinkMacSystemFont, sans-serif'
const AXIS_STROKE = '#6a6a70'
const GRID_STROKE = 'rgba(0, 0, 0, 0.07)'

// 离屏 canvas：测量轴标签宽度用（模块级复用；2d 上下文在常规环境不会为 null）
const measureCtx = document.createElement('canvas').getContext('2d')!

export function UPlotChart({
  data,
  seriesDefs,
  time = true,
  height = 260,
  yFormat,
  xFormat,
  className,
}: UPlotChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<uPlot | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const opts: Options = {
      width: host.clientWidth || 600,
      height,
      class: className,
      scales: { x: { time } },
      axes: [
        {
          stroke: AXIS_STROKE,
          grid: { stroke: GRID_STROKE },
          ticks: { stroke: GRID_STROKE },
          font: AXIS_FONT,
          values: xFormat
            ? (_u: uPlot, splits: number[]) => splits.map(xFormat)
            : undefined,
        },
        {
          stroke: AXIS_STROKE,
          grid: { stroke: GRID_STROKE },
          ticks: { stroke: GRID_STROKE },
          font: AXIS_FONT,
          // uPlot 默认 y 轴宽度固定 50px，长标签（如 ¥1,750.00）会被裁掉；
          // 按实际格式化文本测量宽度自适应
          size: (_u: uPlot, values: string[] | null) => {
            if (values == null || values.length === 0) return 40
            measureCtx.font = AXIS_FONT
            const w = Math.max(...values.map((v) => measureCtx.measureText(String(v)).width))
            return Math.ceil(w + 12)
          },
          values: yFormat
            ? (_u: uPlot, splits: number[]) => splits.map(yFormat)
            : undefined,
        },
      ],
      series: [
        { label: 'x' },
        ...seriesDefs.map((def) => ({
          label: def.label,
          stroke: def.stroke,
          width: def.width ?? 1.6,
          fill: def.fill ?? undefined,
          spanGaps: def.spanGaps ?? true,
          value: def.value,
          paths: def.paths,
          points: def.points,
        })),
      ] as Options['series'],
      legend: { show: true, live: false },
      cursor: {
        // 不做框选缩放，悬浮只显示十字线与数值点
        drag: { x: false, y: false },
        points: { size: 5 },
      },
    }

    const chart = new uPlot(opts, data as AlignedData, host)
    chartRef.current = chart

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth
      if (w > 0 && chartRef.current) chartRef.current.setSize({ width: w, height })
    })
    ro.observe(host)

    return () => {
      ro.disconnect()
      if (chartRef.current) {
        chartRef.current.destroy()
        chartRef.current = null
      }
    }
    // series 数量 / time / 高度 / className / format 任意变 → 重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesDefs.length, time, height, className, yFormat, xFormat])

  // 增量：data 引用变化时调 setData，不重建（同一 metric 切 range / 切时间窗）
  useEffect(() => {
    if (chartRef.current) chartRef.current.setData(data as AlignedData)
  }, [data])

  return <div ref={hostRef} style={{ width: '100%' }} />
}

// ---- 小工具：给日趋势对齐 x/y 数组 ----

/** 把 day 字符串数组 + 各 y 数组对齐为 uPlot AlignedData（x 为 unix 秒） */
export function toTimeAlignedData(
  days: readonly string[],
  ys: readonly (readonly number[])[],
): AlignedData {
  const x = days.map((d) => Math.floor(Date.parse(`${d}T00:00:00`) / 1000))
  return [x, ...ys.map((arr) => Array.from(arr))]
}
