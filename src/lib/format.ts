/** 数字缩写（中文单位）：30_000 → "3.0万", 300_000_000 → "3.0亿"，万以下显示整数 */
export function formatCount(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '0'
  const abs = Math.abs(n)
  if (abs >= 100_000_000) return `${(n / 100_000_000).toFixed(digits)}亿`
  if (abs >= 10_000) return `${(n / 10_000).toFixed(digits).replace(/\.0+$/, '')}万`
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

/** 完整数字 + 单位，便于精确阅读（"4,701,602,255"） */
export function formatFull(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US')
}

/** 百分比：0.873 → "87.3%"，可指定小数位 */
export function formatPct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
}

/** 时长：ms → "1.2s" / "234ms" / "1m 23s" / "1h 5m" */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 2 : 1)}s`
  const min = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  if (min < 60) return s > 0 ? `${min}m ${s}s` : `${min}m`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

/** 字节：1024 进制 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 10 ? 1 : 2)} ${units[i]}`
}

/** 人民币：0.34 → "¥0.34"；1234.5 → "¥1,234.50"；< 0.01 时显示 4 位小数 */
export function formatRMB(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (Math.abs(n) < 0.01 && n !== 0) return `¥${n.toFixed(4)}`
  return `¥${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** 人民币缩写：12345 → "¥12.3K"（用于很长的成本数） */
export function formatRMBShort(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '¥0'
  if (Math.abs(n) < 1) return `¥${n.toFixed(2)}`
  return `¥${formatCount(n, 1)}`
}

/** 友好文件大小（File.size → "1.2 GB"） */
export function formatFileSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 10 ? 1 : 2)} ${units[i]}`
}
