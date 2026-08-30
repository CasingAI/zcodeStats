// uPlot 自定义 paths：单调三次插值（Fritsch–Carlson）平滑曲线。
// 用 bezierCurveTo 逐段构造 Path2D，切向经限幅处理，曲线不会超出数据点
// （避免普通 spline 的过冲鼓包）。fillToZero 时额外产出封闭到零线的面积路径。

import type uPlot from 'uplot'

type Pt = { x: number; y: number }

export type SplinePathsOpts = {
  /** 额外生成封闭到 y=0 的 fill 路径（面积图） */
  fillToZero?: boolean
}

export function splinePaths(opts: SplinePathsOpts = {}) {
  return (u: uPlot, seriesIdx: number, idx0: number, idx1: number) => {
    const xs = u.data[0] as number[]
    const ys = u.data[seriesIdx] as (number | null | undefined)[]
    const scaleKey = u.series[seriesIdx]?.scale ?? 'y'

    // 收集可视范围内（前后各放宽 1 点保证切向连续）的非空点
    const pts: Pt[] = []
    const lo = Math.max(0, idx0 - 1)
    const hi = Math.min(xs.length - 1, idx1 + 1)
    for (let i = lo; i <= hi; i++) {
      const y = ys[i]
      const x = xs[i]
      if (x != null && y != null) {
        pts.push({ x: u.valToPos(x, 'x', true), y: u.valToPos(y, scaleKey, true) })
      }
    }

    const stroke = new Path2D()
    const first = pts[0]
    if (first == null) return { stroke, fill: null }

    const tangents = monotoneTangents(pts)

    // 控制点沿切向偏移 1/3 段长，等价三次样条的 Hermite 形式
    const moveTo = (p: Path2D, a: Pt, b: Pt, ma: number, mb: number) => {
      const dx = (b.x - a.x) / 3
      p.bezierCurveTo(a.x + dx, a.y + ma * dx, b.x - dx, b.y - mb * dx, b.x, b.y)
    }

    stroke.moveTo(first.x, first.y)
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      const ma = tangents[i - 1]
      const mb = tangents[i]
      if (a == null || b == null || ma == null || mb == null) continue
      moveTo(stroke, a, b, ma, mb)
    }

    let fill: Path2D | null = null
    const last = pts[pts.length - 1]
    if (opts.fillToZero && last != null && pts.length > 1) {
      const baseY = Math.min(u.valToPos(0, scaleKey, true), u.height)
      fill = new Path2D(stroke)
      fill.lineTo(last.x, baseY)
      fill.lineTo(first.x, baseY)
      fill.closePath()
    }
    return { stroke, fill }
  }
}

/**
 * 像素坐标下的单调三次切向（Fritsch–Carlson 限幅）。
 * 初值取相邻割线平均（异号回 0），再按 3×割线 限幅，保证单调段不产生过冲。
 */
function monotoneTangents(pts: readonly Pt[]): number[] {
  const n = pts.length
  if (n < 2) return new Array(n).fill(0)
  const p0 = pts[0]!
  const p1 = pts[1]!
  if (n === 2) {
    const d = (p1.y - p0.y) / (p1.x - p0.x)
    return [d, d]
  }

  const d: number[] = []
  for (let k = 0; k < n - 1; k++) {
    const a = pts[k]!
    const b = pts[k + 1]!
    d.push((b.y - a.y) / (b.x - a.x))
  }

  const m: number[] = new Array(n)
  m[0] = d[0]!
  m[n - 1] = d[n - 2]!
  for (let k = 1; k < n - 1; k++) {
    const d0 = d[k - 1]!
    const d1 = d[k]!
    m[k] = d0 * d1 <= 0 ? 0 : (d0 + d1) / 2
  }

  // Fritsch–Carlson 限幅：两端切向与割线的比值平方和 ≤ 9
  for (let k = 0; k < n - 1; k++) {
    const dk = d[k]!
    const mk = m[k]!
    const mk1 = m[k + 1]!
    if (dk === 0) {
      m[k] = 0
      m[k + 1] = 0
      continue
    }
    const a = mk / dk
    const b = mk1 / dk
    const s = a * a + b * b
    if (s > 9) {
      const t = 3 / Math.sqrt(s)
      m[k] = t * a * dk
      m[k + 1] = t * b * dk
    }
  }
  return m
}
