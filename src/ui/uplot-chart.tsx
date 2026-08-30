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

    // tooltip DOM 提前创建：setCursor hook 闭包会引用
    const tip = document.createElement('div')
    tip.className = 'uplot-tooltip'
    tip.style.display = 'none'

    /** 悬浮数值卡片：显示当前 x 与各可见系列的值，跟随光标并做边缘翻转 */
    const updateTooltip = (u: uPlot) => {
      const idx = u.cursor.idx
      const left = u.cursor.left
      const top = u.cursor.top
      if (idx == null || left == null || top == null) {
        tip.style.display = 'none'
        return
      }

      while (tip.firstChild) tip.removeChild(tip.firstChild)
      const xVal = (u.data[0] as (number | undefined)[] | undefined)?.[idx]
      if (xFormat && xVal != null) {
        const head = document.createElement('div')
        head.className = 'uplot-tooltip__title'
        head.textContent = xFormat(xVal)
        tip.appendChild(head)
      }

      // 先收集、再按当日值降序排序，让大值出现在卡片顶部
      const rows: HTMLDivElement[] = []
      for (let s = 1; s < u.series.length; s++) {
        const series = u.series[s]
        if (series == null || !series.show) continue
        const v = (u.data[s] as (number | null | undefined)[] | undefined)?.[idx]
        if (v == null || v === 0) continue
        const def = seriesDefs[s - 1]

        const row = document.createElement('div')
        row.className = 'uplot-tooltip__row'
        // 在 row 上挂原值用于排序（不影响 DOM 渲染）
        ;(row as unknown as { __v: number }).__v = v

        // 圆点颜色用 seriesDefs 源数据：uPlot 内部会改写 series.stroke，
        // 直接读 series.stroke 在多线按模型场景会取到 undefined 显示同色
        const rawStroke = def?.stroke
        const dotColor = typeof rawStroke === 'string' ? rawStroke : '#1c1c1e'

        const dot = document.createElement('span')
        dot.className = 'uplot-tooltip__dot'
        dot.style.background = dotColor
        row.appendChild(dot)

        const label = document.createElement('span')
        label.className = 'uplot-tooltip__label'
        label.textContent = typeof series.label === 'string' ? series.label : ''
        row.appendChild(label)

        const val = document.createElement('span')
        val.className = 'uplot-tooltip__value'
        val.textContent = def?.value ? def.value(u, u, v) : yFormat ? yFormat(v) : String(v)
        row.appendChild(val)

        rows.push(row)
      }
      rows.sort((a, b) => (b as unknown as { __v: number }).__v - (a as unknown as { __v: number }).__v)
      for (const row of rows) tip.appendChild(row)
      // 只有标题但没有任何数据行时也隐藏（避免日期下空空）
      if (tip.childElementCount === 0 || (tip.childElementCount === 1 && tip.firstElementChild?.classList.contains('uplot-tooltip__title'))) {
        tip.style.display = 'none'
        return
      }

      tip.style.display = 'block'
      // 定位在光标右侧 14px，靠近右/上边缘时翻转
      const overW = u.over.clientWidth
      const overH = u.over.clientHeight
      const flipX = left + 14 + tip.offsetWidth > overW
      const x = flipX ? left - tip.offsetWidth - 14 : left + 14
      const y = Math.min(Math.max(top - tip.offsetHeight / 2, 4), Math.max(overH - tip.offsetHeight - 4, 4))
      tip.style.left = `${Math.round(x)}px`
      tip.style.top = `${Math.round(y)}px`
    }

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
      hooks: {
        // 悬浮数值卡片：跟随光标，显示当前 x + 各系列值
        setCursor: [updateTooltip],
      },
    }

    const chart = new uPlot(opts, data as AlignedData, host)
    // tooltip 挂在 .u-over 上（与 canvas 同尺寸、覆盖其上的定位层）
    chart.over.appendChild(tip)
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
