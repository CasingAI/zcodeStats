// 模型分组详情：KPI + uPlot 日趋势 + 0-23 小时分布。
// 路由：#/model/<encodeURIComponent(分组名)>

import { useMemo } from 'preact/hooks'
import uPlot from 'uplot'
import { IosButton } from '../ui/ios-button.tsx'
import { KpiCard } from '../ui/kpi-card.tsx'
import { RangeSelectorTabs, RangeSelectorPanelForBelow, useRangeSelectorState } from '../ui/range-selector.tsx'
import { UPlotChart, toTimeAlignedData } from '../ui/uplot-chart.tsx'
import { useQuery } from '../lib/use-query.ts'
import { navigate } from '../lib/router.ts'
import {
  QUERIES,
  rangeSignature,
  shapeByDay,
  shapeByDayByModel,
  aggregateCostByDay,
  shapeByHour,
  shapeByModel,
  type ParamQuery,
} from '../db/queries.ts'
import type { OpenedDb } from '../db/client.ts'
import type { ByDayRow, ByModelRow } from '../db/types.ts'
import {
  marksSignature,
  normalizeModelName,
  resolveGroupKey,
  useMarks,
  useCustomModels,
} from '../lib/model-groups.ts'
import { useRange } from '../lib/range-context.tsx'
import {
  formatCount,
  formatDuration,
  formatPct,
  formatRMB,
  formatTokensPerSecond,
} from '../lib/format.ts'
import { resolveMatch, displayNameOf, builtinModelKeys, type ModelPrice } from '../lib/pricing.ts'

/** 详情页 heading：group 可能是价目表 key 也可能是 raw id，先尝试映射到正式名，失败回退原 group */
function headingFor(group: string): string {
  if (TABLE_KEY_SET.has(group)) return displayNameOf(group)
  const m = resolveMatch(group)
  if (m.rule !== 'default') return displayNameOf(m.matched)
  return group
}

const TABLE_KEY_SET = new Set(builtinModelKeys())

export type PriceMatch = {
  /** 该 model_id 实际计费用的目标模型名（价目表 key） */
  matched: string
  /** 该目标模型的三档单价（¥/1M） */
  price: ModelPrice
  /** 匹配规则：标记 / 精确 / 归一化 / 内置别名 / 默认 */
  rule: 'mark' | 'exact' | 'normalized' | 'custom-normalized' | 'builtin-alias' | 'default'
}

type ModelDetailData = {
  ids: string[]
  calls: number
  totalTokens: number
  errorCount: number
  cacheHitRate: number
  cost: number
  avgOutputSpeed: number | null
  avgTtftMs: number | null
  avgDurationMs: number | null
  speedSampleCount: number
  ttftSampleCount: number
  daily: ByDayRow[]
  /** 0-23 时的 token 聚合（对 weekday 折叠） */
  hourTokens: number[]
  hourCalls: number[]
  /** 0-23 时的 speed / TTFT 聚合（对 weekday 折叠） */
  hourSpeed: (number | null)[]
  hourTtft: (number | null)[]
  /** 每个 model_id 对应的「实际计费目标 + 规则」（按 ids 同序） */
  priceMatches: PriceMatch[]
  /** 每个 model_id 的 token 拆分（用于价格计算法区块） */
  perIdTokens: ReadonlyMap<
    string,
    {
      input: number
      output: number
      reasoning: number
      cacheRead: number
      cacheCreation: number
    }
  >
}

export function ModelDetailPage({ db, group }: { db: OpenedDb; group: string }) {
  const { range, setPreset, setCustom } = useRange()
  const rs = useRangeSelectorState({ value: range, onPreset: setPreset, onCustom: setCustom })
  const marks = useMarks()
  const custom = useCustomModels()

  const state = useQuery<ModelDetailData>(
    db,
    `model-detail:${group}:${rangeSignature(range)}:${marksSignature(marks, custom)}`,
    async (d) => {
      // 先拿 range 内的全部 id 行，解析出该分组下的 model_id 集合
      const all: ByModelRow[] = shapeByModel(
        await d.select(QUERIES.byModel(range).sql, QUERIES.byModel(range).bind),
      )
      // 命中规则与列表页两种聚合方式保持一致：id 完全相等、名字归一化相等、
      // 或标记值相等，任一满足即归入该分组。
      // dedup 关键：后续 SQL IN、priceMatches、perIdTokens 都按 ids 遍历，
      // 不去重会让 4 个同 model_id 不同 provider 的行被 token 累加 4 次（→ 4 倍价目）。
      const rawIds = all
        .map((r) => r.modelId)
        .filter(
          (id) =>
            id !== '' &&
            (id === group ||
              normalizeModelName(id) === group ||
              resolveGroupKey(id, 'name', marks) === group),
        )
      const ids = dedupPreserveOrder(rawIds)
      const own = all.filter((r) => r.modelId !== '' && ids.includes(r.modelId))

      let calls = 0
      let totalTokens = 0
      let errorCount = 0
      let inputTokens = 0
      let cacheCreation = 0
      let cacheRead = 0
      let cost = 0
      let speedOutputTokens = 0
      let speedDurationMs = 0
      let speedSampleCount = 0
      let ttftSumMs = 0
      let ttftSampleCount = 0
      let totalDurationMs = 0
      // 按 modelId 各自累加 token：价格计算法区块需要拆分到每个 (matched, rule) bucket
      const perId = new Map<
        string,
        {
          input: number
          output: number
          reasoning: number
          cacheRead: number
          cacheCreation: number
        }
      >()
      for (const r of own) {
        calls += r.calls
        totalTokens += r.totalTokens
        errorCount += r.errorCount
        inputTokens += r.inputTokens
        cacheCreation += r.cacheCreationTokens
        cacheRead += r.cacheReadTokens
        cost += r.cost
        speedOutputTokens += r.speedOutputTokens
        speedDurationMs += r.speedDurationMs
        speedSampleCount += r.speedSampleCount
        ttftSumMs += r.ttftSumMs
        ttftSampleCount += r.ttftSampleCount
        totalDurationMs += r.totalDurationMs
        const cur = perId.get(r.modelId) ?? {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheCreation: 0,
        }
        cur.input += r.inputTokens
        cur.output += r.outputTokens
        cur.reasoning += r.reasoningTokens
        cur.cacheRead += r.cacheReadTokens
        cur.cacheCreation += r.cacheCreationTokens
        perId.set(r.modelId, cur)
      }
      const cacheHitRate =
        inputTokens + cacheCreation > 0 ? cacheRead / (inputTokens + cacheCreation) : 0

      const dayQ: ParamQuery = QUERIES.byDay(range, ids)
      const dbyMQ: ParamQuery = QUERIES.byDayByModel(range)
      const [dayR, dbyMR, hourR] = await Promise.all([
        d.select(dayQ.sql, dayQ.bind),
        d.select(dbyMQ.sql, dbyMQ.bind),
        d.select(QUERIES.byHour(range, ids).sql, QUERIES.byHour(range, ids).bind),
      ])
      // byDayByModel 是全量；按 ids 过滤后再折叠到 day → cost
      const dbyMRows = shapeByDayByModel(dbyMR).filter(
        (r) => r.modelId !== '' && ids.includes(r.modelId),
      )
      const costMap = aggregateCostByDay(dbyMRows)
      const daily = shapeByDay(dayR, costMap)
      const grid = shapeByHour(hourR)

      // weekday×hour 折叠成 0-23
      const hourTokens = new Array<number>(24).fill(0)
      const hourCalls = new Array<number>(24).fill(0)
      const hourSpeedOut = new Array<number>(24).fill(0)
      const hourSpeedDur = new Array<number>(24).fill(0)
      const hourTtftSum = new Array<number>(24).fill(0)
      const hourTtftCnt = new Array<number>(24).fill(0)
      const hourDurSum = new Array<number>(24).fill(0)
      const hourDurCnt = new Array<number>(24).fill(0)
      for (const c of grid.cells) {
        hourTokens[c.hour]! += c.totalTokens
        hourCalls[c.hour]! += c.calls
        hourSpeedOut[c.hour]! += c.speedOutputTokens
        hourSpeedDur[c.hour]! += c.speedDurationMs
        hourTtftSum[c.hour]! += c.ttftSumMs
        hourTtftCnt[c.hour]! += c.ttftSampleCount
        hourDurSum[c.hour]! += c.totalDurationMs
        hourDurCnt[c.hour]! += c.speedSampleCount
      }
      const hourSpeed: (number | null)[] = hourSpeedDur.map((d, i) =>
        d > 0 ? (hourSpeedOut[i]! / d) * 1000 : null,
      )
      const hourTtft: (number | null)[] = hourTtftCnt.map((c, i) =>
        c > 0 ? hourTtftSum[i]! / c : null,
      )

      // 每个 model_id 的价目匹配（用于详情页"价目匹配"区块）。
      // 用 ids 同序；ids 里的 id 都在分组的 own 里，至少有一个 row。
      const priceMatches: PriceMatch[] = ids.map((id) => {
        const r = resolveMatch(id)
        return { matched: r.matched, price: r.price, rule: r.rule }
      })

      const avgOutputSpeed = speedDurationMs > 0 ? (speedOutputTokens / speedDurationMs) * 1000 : null
      const avgTtftMs = ttftSampleCount > 0 ? ttftSumMs / ttftSampleCount : null
      const avgDurationMs = speedSampleCount > 0 ? totalDurationMs / speedSampleCount : null
      return {
        ids,
        calls,
        totalTokens,
        errorCount,
        cacheHitRate,
        cost,
        avgOutputSpeed,
        avgTtftMs,
        avgDurationMs,
        speedSampleCount,
        ttftSampleCount,
        daily,
        hourTokens,
        hourCalls,
        hourSpeed,
        hourTtft,
        priceMatches,
        perIdTokens: perId,
      }
    },
  )

  return (
    <div class="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <IosButton tone="secondary" size="compact" onClick={() => navigate('by-model')}>
          ‹ 返回
        </IosButton>
        <h1 class="page__title mono" style={{ margin: 0, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{headingFor(group)}</h1>
        <RangeSelectorTabs state={rs} ariaLabel="时间范围" />
      </div>

      <RangeSelectorPanelForBelow state={rs} />

      <p
        class="page__subtitle mono"
        style={{ wordBreak: 'break-all', marginTop: -6 }}
      >
        {state.kind === 'ok' ? dedupPreserveOrder(state.data.ids).join(' · ') : '…'}
      </p>

      {state.kind === 'loading' && <div class="app-banner">加载中…</div>}
      {state.kind === 'error' && <div class="app-banner app-banner--error">{state.error}</div>}

      {state.kind === 'ok' && state.data.ids.length === 0 && (
        <div class="app-banner">没有匹配该分组的模型（分组名可能已改动）</div>
      )}

      {state.kind === 'ok' && state.data.ids.length > 0 && (
        <>
          <div class="kpi-grid kpi-grid--3">
            <KpiCard label="总 token" value={formatCount(state.data.totalTokens)} tone="blue" />
            <KpiCard label="调用数" value={formatCount(state.data.calls)} />
            <KpiCard label="缓存命中率" value={formatPct(state.data.cacheHitRate, 1)} tone="green" />
            <KpiCard
              label="错误数"
              value={state.data.errorCount > 0 ? formatCount(state.data.errorCount) : '0'}
              tone={state.data.errorCount > 0 ? 'red' : 'default'}
            />
            <KpiCard
              label="大致成本"
              value={formatRMB(state.data.cost)}
              tone="orange"
              sub={costSubLine(state.data.priceMatches)}
            />
            <KpiCard
              label="平均输出速度"
              value={
                state.data.avgOutputSpeed != null
                  ? formatTokensPerSecond(state.data.avgOutputSpeed)
                  : '—'
              }
              tone="purple"
              sub={`${formatCount(state.data.speedSampleCount)} 次有效样本`}
            />
            <KpiCard
              label="平均 TTFT"
              value={state.data.avgTtftMs != null ? formatDuration(state.data.avgTtftMs) : '—'}
              tone="green"
              sub={`${formatCount(state.data.ttftSampleCount)} 次有效样本`}
            />
            <KpiCard
              label="平均耗时"
              value={state.data.avgDurationMs != null ? formatDuration(state.data.avgDurationMs) : '—'}
              tone="default"
            />
          </div>

          <div class="section">
            <h2 class="section__title">价目匹配</h2>
            <PriceMatchTable ids={state.data.ids} matches={state.data.priceMatches} />
          </div>

          <div class="section">
            <h2 class="section__title">价格计算法</h2>
            <PriceFormulaSection
              ids={state.data.ids}
              matches={state.data.priceMatches}
              perIdTokens={state.data.perIdTokens}
              totalCost={state.data.cost}
            />
          </div>

          <div class="section">
            <h2 class="section__title">日趋势</h2>
            {state.data.daily.length === 0 ? (
              <div class="app-banner">所选时间窗内无数据</div>
            ) : (
              <UPlotChart
                data={toTimeAlignedData(state.data.daily.map((r) => r.day), [
                  state.data.daily.map((r) => r.totalTokens),
                  state.data.daily.map((r) => r.cacheReadTokens),
                ])}
                time
                height={240}
                seriesDefs={dailySeriesDefs}
                yFormat={(v) => (Math.abs(v) >= 1000 ? formatCount(v) : String(Math.round(v)))}
                xFormat={(v) => {
                  const d = new Date(v * 1000)
                  return `${d.getUTCFullYear() % 100}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`
                }}
              />
            )}
          </div>

          <div class="section">
            <h2 class="section__title">输出速度日趋势</h2>
            {state.data.daily.length === 0 ? (
              <div class="app-banner">所选时间窗内无数据</div>
            ) : (
              <UPlotChart
                data={toTimeAlignedData(state.data.daily.map((r) => r.day), [
                  state.data.daily.map((r) => r.avgOutputSpeed ?? 0),
                ])}
                time
                height={220}
                seriesDefs={dailySpeedSeriesDefs}
                yFormat={(v) => formatTokensPerSecond(v)}
                xFormat={(v) => {
                  const d = new Date(v * 1000)
                  return `${d.getUTCFullYear() % 100}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`
                }}
              />
            )}
          </div>

          <div class="section">
            <h2 class="section__title">TTFT 日趋势</h2>
            {state.data.daily.length === 0 ? (
              <div class="app-banner">所选时间窗内无数据</div>
            ) : (
              <UPlotChart
                data={toTimeAlignedData(state.data.daily.map((r) => r.day), [
                  state.data.daily.map((r) => r.avgTtftMs ?? 0),
                ])}
                time
                height={220}
                seriesDefs={dailyTtftSeriesDefs}
                yFormat={(v) => formatDuration(v)}
                xFormat={(v) => {
                  const d = new Date(v * 1000)
                  return `${d.getUTCFullYear() % 100}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`
                }}
              />
            )}
          </div>

          <div class="section">
            <h2 class="section__title">小时分布（0–23 时聚合）</h2>
            <UPlotChart
              data={[
                Array.from({ length: 24 }, (_, i) => i),
                state.data.hourTokens,
              ]}
              time={false}
              height={200}
              seriesDefs={hourSeriesDefs}
              yFormat={(v) => (Math.abs(v) >= 1000 ? formatCount(v) : String(Math.round(v)))}
              xFormat={(v) => `${String(Math.round(v)).padStart(2, '0')}时`}
            />
          </div>

          <div class="section">
            <h2 class="section__title">输出速度小时分布（0–23 时聚合）</h2>
            <UPlotChart
              data={[
                Array.from({ length: 24 }, (_, i) => i),
                state.data.hourSpeed.map((v) => v ?? 0),
              ]}
              time={false}
              height={200}
              seriesDefs={hourSpeedSeriesDefs}
              yFormat={(v) => formatTokensPerSecond(v)}
              xFormat={(v) => `${String(Math.round(v)).padStart(2, '0')}时`}
            />
          </div>

          <div class="section">
            <h2 class="section__title">TTFT 小时分布（0–23 时聚合）</h2>
            <UPlotChart
              data={[
                Array.from({ length: 24 }, (_, i) => i),
                state.data.hourTtft.map((v) => v ?? 0),
              ]}
              time={false}
              height={200}
              seriesDefs={hourTtftSeriesDefs}
              yFormat={(v) => formatDuration(v)}
              xFormat={(v) => `${String(Math.round(v)).padStart(2, '0')}时`}
            />
          </div>
        </>
      )}
    </div>
  )
}

const dailySeriesDefs = [
  {
    label: '总 token',
    stroke: '#1f6ec7',
    width: 2,
    fill: 'rgba(47, 135, 226, 0.08)',
    value: (_u: unknown, _raw: unknown, v: number | null) => (v == null ? '—' : formatCount(v)),
  },
  {
    label: '缓存读取',
    stroke: '#34c759',
    width: 1.5,
    value: (_u: unknown, _raw: unknown, v: number | null) => (v == null ? '—' : formatCount(v)),
  },
]

const dailySpeedSeriesDefs = [
  {
    label: '输出速度 (tok/s)',
    stroke: '#8e6cc7',
    width: 2,
    fill: 'rgba(142, 108, 199, 0.12)',
    value: (_u: unknown, _raw: unknown, v: number | null) =>
      v == null || v === 0 ? '—' : formatTokensPerSecond(v),
  },
]

const dailyTtftSeriesDefs = [
  {
    label: 'TTFT (ms)',
    stroke: '#34c759',
    width: 2,
    fill: 'rgba(52, 199, 89, 0.12)',
    value: (_u: unknown, _raw: unknown, v: number | null) =>
      v == null || v === 0 ? '—' : formatDuration(v),
  },
]

const hourSeriesDefs = [
  {
    label: 'token',
    stroke: '#8e6cc7',
    width: 1.4,
    fill: 'rgba(142, 108, 199, 0.25)',
    paths: uPlot.paths!.bars!({ size: [0.75, 100] }),
    points: { show: false },
    value: (_u: unknown, _raw: unknown, v: number | null) => (v == null ? '—' : formatCount(v)),
  },
]

const hourSpeedSeriesDefs = [
  {
    label: '输出速度 (tok/s)',
    stroke: '#1f6ec7',
    width: 1.4,
    fill: 'rgba(31, 110, 199, 0.12)',
    paths: uPlot.paths!.bars!({ size: [0.75, 100] }),
    points: { show: false },
    value: (_u: unknown, _raw: unknown, v: number | null) =>
      v == null || v === 0 ? '—' : formatTokensPerSecond(v),
  },
]

const hourTtftSeriesDefs = [
  {
    label: 'TTFT (ms)',
    stroke: '#34c759',
    width: 1.4,
    fill: 'rgba(52, 199, 89, 0.12)',
    paths: uPlot.paths!.bars!({ size: [0.75, 100] }),
    points: { show: false },
    value: (_u: unknown, _raw: unknown, v: number | null) =>
      v == null || v === 0 ? '—' : formatDuration(v),
  },
]

function dedupPreserveOrder(arr: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of arr) {
    if (!seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

// ---- 价目匹配区块 ----

const RULE_LABEL: Record<PriceMatch['rule'], string> = {
  mark: '已标记',
  exact: '精确',
  normalized: '归一化',
  'custom-normalized': '归一化(自定义)',
  'builtin-alias': '内置别名',
  default: '默认兜底',
}

function PriceMatchTable({
  ids,
  matches,
}: {
  ids: readonly string[]
  matches: readonly PriceMatch[]
}) {
  // 合并规则：同一组 model_id 若 (matched, rule) 完全一致 → 合并成一行。
  // 常见场景：按名字聚合模式下，几个 raw id 全部命中同一目标（如 4 个 GLM-5.3 全是精确匹配），
  // 此时每行列出完全一样的内容，浪费空间；合并后只显示一次价目，model_id 用 ' · ' 拼接。
  const rows = useMemo(() => {
    const buckets = new Map<
      string,
      { ids: string[]; matched: string; rule: PriceMatch['rule']; price: ModelPrice }
    >()
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] ?? ''
      const m = matches[i]
      if (!id || !m) continue
      const key = `${m.matched}\u0000${m.rule}`
      const b = buckets.get(key)
      if (b) {
        b.ids.push(id)
      } else {
        buckets.set(key, {
          ids: [id],
          matched: m.matched,
          rule: m.rule,
          price: m.price,
        })
      }
    }
    return [...buckets.values()]
  }, [ids, matches])

  const totalIds = ids.length

  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 12,
          color: '#1c1c1e',
        }}
      >
        <thead>
          <tr style={{ textAlign: 'left', color: '#6a6a6f', fontWeight: 500 }}>
            <th style={th()}>model_id</th>
            <th style={th()}>实际计费</th>
            <th style={{ ...th(), textAlign: 'right' }}>输入 ¥/1M</th>
            <th style={{ ...th(), textAlign: 'right' }}>输出 ¥/1M</th>
            <th style={{ ...th(), textAlign: 'right' }}>缓存读 ¥/1M</th>
            <th style={th()}>匹配规则</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.matched}\u0000${r.rule}`} style={{ borderTop: '1px solid #ececef' }}>
              <td
                class="mono"
                style={{ ...td(), wordBreak: 'break-all', maxWidth: 360 }}
              >
                {r.ids.join(' · ')}
                {r.ids.length > 1 && (
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 10,
                      color: '#8a8a90',
                    }}
                    title={`该行合并了 ${r.ids.length} 个 model_id`}
                  >
                    （{r.ids.length} 个）
                  </span>
                )}
              </td>
              <td class="mono" style={td()}>{r.matched}</td>
              <td style={{ ...td(), textAlign: 'right' }}>{r.price.input.toFixed(2)}</td>
              <td style={{ ...td(), textAlign: 'right' }}>{r.price.output.toFixed(2)}</td>
              <td style={{ ...td(), textAlign: 'right' }}>{r.price.cacheInput.toFixed(2)}</td>
              <td style={td()}>
                <span style={ruleTag(r.rule)} title={RULE_LABEL[r.rule]}>
                  {RULE_LABEL[r.rule]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length < totalIds && (
        <div style={{ fontSize: 10, color: '#8a8a90', marginTop: 6 }}>
          共 {totalIds} 个 model_id，合并后 {rows.length} 条价目。
        </div>
      )}
    </div>
  )
}

function th(): preact.JSX.CSSProperties {
  return {
    padding: '6px 8px',
    borderBottom: '1px solid #ececef',
    fontWeight: 500,
    fontSize: 11,
  }
}

function td(): preact.JSX.CSSProperties {
  return { padding: '6px 8px', verticalAlign: 'top' }
}

function ruleTag(rule: PriceMatch['rule']): preact.JSX.CSSProperties {
  const isDefault = rule === 'default'
  return {
    fontSize: 9,
    fontWeight: 700,
    color: isDefault ? '#a23b3b' : '#1f6f43',
    background: isDefault ? '#fde2e2' : '#d4f4e1',
    borderRadius: 6,
    padding: '1px 5px',
    lineHeight: 1.4,
  }
}

/** 简洁版摘要，给"大致成本" KPI 的 sub。多个不同目标时列出前 2 个并省略号。 */
function costSubLine(matches: readonly PriceMatch[]): string {
  if (matches.length === 0) return '按价目表 / 标记估算'
  const set = new Set(matches.map((m) => m.matched))
  const arr = [...set]
  if (arr.length === 1) return `按 ${arr[0]} 价`
  if (arr.length === 2) return `按 ${arr[0]} / ${arr[1]} 价`
  return `按 ${arr[0]} 等 ${arr.length} 种价`
}

// ---- 价格计算法区块 ----

type PerIdTokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheCreation: number
}

type FormulaBucket = {
  matched: string
  rule: PriceMatch['rule']
  price: ModelPrice
  /** 该 bucket 内所有 model_id 累加的 token */
  inTok: number
  outTok: number
  reasonTok: number
  cacheRTok: number
  cacheWTok: number
  /** 算出来的成本 (¥) */
  cost: number
}

function PriceFormulaSection({
  ids,
  matches,
  perIdTokens,
  totalCost,
}: {
  ids: readonly string[]
  matches: readonly PriceMatch[]
  perIdTokens: ReadonlyMap<string, PerIdTokens>
  totalCost: number
}) {
  // 跟 PriceMatchTable 用同样的合并 key：同一 (matched, rule) 行的 token 累加后共享一个公式
  const buckets = useMemo<FormulaBucket[]>(() => {
    const out = new Map<string, FormulaBucket>()
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] ?? ''
      const m = matches[i]
      if (!id || !m) continue
      const t = perIdTokens.get(id) ?? {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheCreation: 0,
      }
      const key = `${m.matched}\u0000${m.rule}`
      const b = out.get(key)
      if (b) {
        b.inTok += t.input
        b.outTok += t.output
        b.reasonTok += t.reasoning
        b.cacheRTok += t.cacheRead
        b.cacheWTok += t.cacheCreation
      } else {
        out.set(key, {
          matched: m.matched,
          rule: m.rule,
          price: m.price,
          inTok: t.input,
          outTok: t.output,
          reasonTok: t.reasoning,
          cacheRTok: t.cacheRead,
          cacheWTok: t.cacheCreation,
          cost: 0,
        })
      }
    }
    for (const b of out.values()) {
      const inB = (b.inTok + b.cacheWTok) / 1_000_000
      const outB = (b.outTok + b.reasonTok) / 1_000_000
      const cacheB = b.cacheRTok / 1_000_000
      b.cost = inB * b.price.input + outB * b.price.output + cacheB * b.price.cacheInput
    }
    return [...out.values()]
  }, [ids, matches, perIdTokens])

  const computedTotal = buckets.reduce((s, b) => s + b.cost, 0)
  // 总成本做浮点对账（允许 ±0.01 ¥ 误差）
  const drift = Math.abs(computedTotal - totalCost)
  const driftNote =
    drift > 0.01 && drift / Math.max(totalCost, 0.01) > 0.001
      ? `（与上方"大致成本" ¥${totalCost.toFixed(2)} 相差 ¥${drift.toFixed(2)}，可能是浮点累积）`
      : ''

  return (
    <div style={{ fontSize: 12, color: '#1c1c1e' }}>
      <div
        style={{
          padding: '8px 10px',
          background: '#f7f7f9',
          border: '1px solid #ececef',
          borderRadius: 6,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 12,
          lineHeight: 1.6,
        }}
      >
        <div style={{ marginBottom: 4, color: '#6a6a6f' }}>
          计价公式（单位：<b>token 用 M</b> = 百万；<b>价格 = ¥ / 1M token</b>；
          缓存写按"输入价"计，reasoning 并入"输出价"）：
        </div>
        <div class="mono">
          ¥ = (输入 + 缓存写) × 输入价 + (输出 + reasoning) × 输出价 + 缓存读 × 缓存价
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        {buckets.map((b) => {
          const isDefault = b.rule === 'default'
          return (
            <div
              key={`${b.matched}\u0000${b.rule}`}
              style={{
                padding: '8px 10px',
                marginBottom: 8,
                background: isDefault ? '#fff5f5' : '#fafafc',
                border: `1px solid ${isDefault ? '#f3c2c2' : '#ececef'}`,
                borderRadius: 6,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 4,
                  fontSize: 11,
                  color: '#6a6a6f',
                }}
              >
                <span>按</span>
                <span class="mono" style={{ color: '#1c1c1e', fontWeight: 600 }}>
                  {b.matched}
                </span>
                <span style={ruleTag(b.rule)}>{RULE_LABEL[b.rule]}</span>
                {isDefault && (
                  <span style={{ marginLeft: 4, color: '#a23b3b' }}>
                    ← 兜底价；该组实际成本很可能偏低
                  </span>
                )}
              </div>
              <div
                class="mono"
                style={{
                  fontSize: 12,
                  lineHeight: 1.7,
                  wordBreak: 'break-all',
                  color: isDefault ? '#7a2a2a' : '#1c1c1e',
                }}
              >
                ({fmtTok(b.inTok)} + {fmtTok(b.cacheWTok)}) × ¥{b.price.input.toFixed(2)}
                {' + '}
                ({fmtTok(b.outTok)} + {fmtTok(b.reasonTok)}) × ¥{b.price.output.toFixed(2)}
                {' + '}
                {fmtTok(b.cacheRTok)} × ¥{b.price.cacheInput.toFixed(2)}
                {' = '}
                <span style={{ fontWeight: 600 }}>¥{b.cost.toFixed(2)}</span>
              </div>
              <div style={{ fontSize: 10, color: '#8a8a90', marginTop: 2 }}>
                下面给"输入档"一档手算示例（token 单位自动匹配 token 数量级）：
                {' '}
                <span class="mono">
                  {fmtTokWithUnit(b.inTok + b.cacheWTok)} × {pricePerYi(b.price.input)}
                  {' = '}
                  ¥{((b.inTok + b.cacheWTok) / 1_000_000 * b.price.input).toFixed(2)}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      <div
        style={{
          marginTop: 4,
          padding: '6px 10px',
          background: '#1f6ec7',
          color: '#fff',
          borderRadius: 6,
          fontSize: 13,
        }}
      >
        <span style={{ marginRight: 8 }}>本组合计：</span>
        <span class="mono" style={{ fontWeight: 700 }}>¥{computedTotal.toFixed(2)}</span>
        {driftNote && (
          <span style={{ marginLeft: 8, fontSize: 10, opacity: 0.85 }}>{driftNote}</span>
        )}
      </div>
    </div>
  )
}

/**
 * token 整数缩写：
 *   < 1000       → 整数（无单位）
 *   < 1M         → 1.2K / 12K
 *   < 100M       → 12.3M / 123.4M（自动选 1-2 位小数）
 *   ≥ 100M       → 1.23亿（2 位小数；M 单位三位数切到"亿"避免出现 12345M）
 */
function fmtTok(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
  if (n < 100_000_000) {
    const m = n / 1_000_000
    return `${m.toFixed(m < 10 ? 2 : m < 100 ? 1 : 0)}M`
  }
  // n ≥ 1 亿
  const yi = n / 100_000_000
  return `${yi.toFixed(2)}亿`
}

/**
 * 给"手算示例"用：token + 自带单位，配 pricePerYi() 出来的价格单位。
 *   < 1M    → 12.3K
 *   < 100M → 12.3M
 *   ≥ 100M → 1.23亿
 */
function fmtTokWithUnit(n: number): string {
  return fmtTok(n)
}

/**
 * 价格按"亿"自动配对：
 *   ¥3.00/M → ¥300/亿
 *   ¥9.00/M → ¥900/亿
 * 让手算示例 "X亿 × ¥Y/亿 = ¥Z" 数字配对、单位一致。
 */
function pricePerYi(perM: number): string {
  const perYi = perM * 100
  return `¥${perYi.toFixed(2)}/亿`
}
