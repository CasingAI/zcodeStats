import { useMemo, useState } from 'preact/hooks'
import { DataTable } from '../ui/data-table.tsx'
import { IosButton } from '../ui/ios-button.tsx'
import { SegmentedControl } from '../ui/segmented-control.tsx'
import '../ui/ios-text-field.css'
import { useQuery } from '../lib/use-query.ts'
import { navigate } from '../lib/router.ts'
import {
  QUERIES,
  shapeByModel,
  type Range,
} from '../db/queries.ts'
import type { OpenedDb } from '../db/client.ts'
import type { ByModelRow } from '../db/types.ts'
import {
  type CustomModelMap,
  type GroupMode,
  type GroupedModelRow,
  type MarkMap,
  marksSignature,
  resolveGroups,
  saveCustomModels,
  saveMarks,
  useCustomModels,
  useMarks,
} from '../lib/model-groups.ts'
import { builtinModelKeys, isMarkedModel } from '../lib/pricing.ts'
import { formatCount, formatPct, formatRMB } from '../lib/format.ts'

const BYMODEL_LIMIT = 5000

export function ByModelPage({ db }: { db: OpenedDb }) {
  const [mode, setMode] = useState<GroupMode>('id')
  const [range, setRange] = useState<Range>('all')
  const marks = useMarks()
  const custom = useCustomModels()
  const [editing, setEditing] = useState(false)

  const state = useQuery<ByModelRow[]>(
    db,
    `by-model:${range}:${marksSignature(marks, custom)}`,
    async (d) => {
      const r = await d.select(QUERIES.byModel(range).sql, QUERIES.byModel(range).bind)
      return shapeByModel(r)
    },
  )

  const grouped: GroupedModelRow[] = useMemo(() => {
    if (state.kind !== 'ok') return []
    return resolveGroups(state.data, mode, marks)
  }, [state.kind === 'ok' ? state.data : null, mode, marks])

  const truncated =
    state.kind === 'ok' && state.data.length >= BYMODEL_LIMIT

  return (
    <div class="page">
      <div class="section__header">
        <div style={{ minWidth: 0, flex: '1 1 280px' }}>
          <h1 class="page__title">按模型</h1>
          <p class="page__subtitle" style={{ minWidth: 0 }}>
            点击行查看该模型的日 / 小时趋势；"标记模型"可以把任意 model_id 合并到内置或自定义模型上
          </p>
          <p
            class="page__subtitle"
            style={{ fontSize: 11, color: '#8a8a90', marginTop: 2, minWidth: 0 }}
          >
            "已标记"=用户手动指定计价模型；"已识别"=自动命中价目表；"未识别"=按 v4-pro 默认价估算成本，仅供量级参考。
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <SegmentedControl<Range>
            value={range}
            onChange={setRange}
            ariaLabel="时间范围"
            items={[
              { id: '7d', label: '近7天' },
              { id: '30d', label: '近30天' },
              { id: 'all', label: '全部' },
            ]}
          />
          <SegmentedControl<GroupMode>
            value={mode}
            onChange={setMode}
            ariaLabel="聚合方式"
            items={[
              { id: 'id', label: '按ID' },
              { id: 'name', label: '按名字聚合' },
            ]}
          />
          <IosButton tone="secondary" size="compact" onClick={() => setEditing(true)}>
            标记模型
          </IosButton>
        </div>
      </div>

      <div class="section">
        {truncated && (
          <div class="app-banner">
            展示前 {BYMODEL_LIMIT} 个 model_id。说明：按时间范围缩小到「近7天/30天」通常就能看完。
          </div>
        )}
        {state.kind === 'loading' && (
          <DataTable columns={columns} rows={[]} rowKey={() => ''} loading />
        )}
        {state.kind === 'error' && <div class="app-banner app-banner--error">{state.error}</div>}
        {state.kind === 'ok' && (
          <DataTable
            columns={columns}
            rows={grouped}
            rowKey={(r) => r.groupKey}
            emptyMessage="没有数据"
            onRowClick={(r) => navigate(`model/${encodeURIComponent(r.groupKey)}`)}
          />
        )}
      </div>

      {editing && state.kind === 'ok' && (
        <MarkEditor
          rows={state.data}
          marks={marks}
          custom={custom}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  )
}

// ---- 标记弹窗 ----

type DraftState = {
  marks: MarkMap
  custom: CustomModelMap
}

function MarkEditor({
  rows,
  marks,
  custom,
  onClose,
}: {
  rows: ByModelRow[]
  marks: MarkMap
  custom: CustomModelMap
  onClose: () => void
}) {
  const [draft, setDraft] = useState<DraftState>(() => {
    // 预填：只保留仍存在的 model_id
    const alive: MarkMap = {}
    for (const r of rows) {
      const id = r.modelId
      if (id && marks[id]) alive[id] = marks[id]!
    }
    return { marks: alive, custom: { ...custom } }
  })
  const [showNewCustom, setShowNewCustom] = useState(false)

  const sorted = [...rows].sort((a, b) => b.totalTokens - a.totalTokens)
  const builtinKeys = builtinModelKeys()
  const customKeys = Object.keys(draft.custom).sort()

  return (
    <div class="app-modal" role="dialog" aria-modal="true">
      <div class="app-modal__panel" style={{ minWidth: 560, maxWidth: 720 }}>
        <div class="app-modal__title">模型标记</div>
        <div class="app-modal__body">
          给任意 model_id 选一个目标模型（内置或自定义），相同目标会被合并到同一组并按目标价计算成本。
          留"不标记"则按 id 原样展示，成本走自动识别。配置保存在浏览器 localStorage。
        </div>

        <div class="alias-editor__list" style={{ maxHeight: 420, overflowY: 'auto' }}>
          {sorted.map((r) => {
            const id = r.modelId ?? '(未知)'
            const value = draft.marks[id] ?? ''
            return (
              <div key={id} class="alias-editor__row" style={{ flexWrap: 'wrap' }}>
                <div class="alias-editor__id">
                  <span class="mono" style={{ fontSize: 11 }}>{id}</span>
                  <span style={{ fontSize: 10, color: '#8a8a90' }}>
                    {formatCount(r.totalTokens)} tok · {formatCount(r.calls)} 次
                  </span>
                </div>
                <button
                  type="button"
                  title="复制 model_id"
                  aria-label={`复制 ${id}`}
                  style={copyBtnStyle}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(id)
                    } catch {
                      /* clipboard 不可用时静默 */
                    }
                  }}
                >
                  ⧉ 复制
                </button>
                <select
                  class="ios-text-field alias-editor__input"
                  style={{ minWidth: 200 }}
                  value={value}
                  onChange={(e) => {
                    const v = (e.target as HTMLSelectElement).value
                    if (v === '__new__') {
                      setShowNewCustom(true)
                      return
                    }
                    setDraft((prev) => {
                      const nextMarks = { ...prev.marks }
                      if (v) nextMarks[id] = v
                      else delete nextMarks[id]
                      return { ...prev, marks: nextMarks }
                    })
                  }}
                >
                  <option value="">（不标记）</option>
                  {builtinKeys.length > 0 && (
                    <optgroup label="内置模型">
                      {builtinKeys.map((k: string) => (
                        <option key={k} value={k}>{k}</option>
                      ))}
                    </optgroup>
                  )}
                  {customKeys.length > 0 && (
                    <optgroup label="自定义模型">
                      {customKeys.map((k: string) => (
                        <option key={k} value={k}>{k}</option>
                      ))}
                    </optgroup>
                  )}
                  <option value="__new__">＋ 新建自定义模型…</option>
                </select>
              </div>
            )
          })}
        </div>

        {showNewCustom && (
          <NewCustomModelForm
            onCancel={() => setShowNewCustom(false)}
            onCreate={(name, price) => {
              if (!name) return
              setDraft((prev) => ({
                ...prev,
                custom: { ...prev.custom, [name]: price },
              }))
              setShowNewCustom(false)
            }}
          />
        )}

        {customKeys.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4, color: '#4a4a4f' }}>
              自定义模型
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {customKeys.map((k) => {
                const p = draft.custom[k]!
                return (
                  <div
                    key={k}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 11,
                      color: '#4a4a4f',
                    }}
                  >
                    <span class="mono" style={{ flex: 1 }}>{k}</span>
                    <span style={{ color: '#8a8a90' }}>
                      ¥{p.input}/{p.output}/{p.cacheInput} /1M
                    </span>
                    <button
                      type="button"
                      title="删除自定义模型（同时移除指向它的标记）"
                      style={copyBtnStyle}
                      onClick={() => {
                        setDraft((prev) => {
                          const nextCustom = { ...prev.custom }
                          delete nextCustom[k]
                          const nextMarks: MarkMap = {}
                          for (const [mk, mv] of Object.entries(prev.marks)) {
                            if (mv !== k) nextMarks[mk] = mv
                          }
                          return { custom: nextCustom, marks: nextMarks }
                        })
                      }}
                    >
                      删除
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div class="app-modal__actions">
          <IosButton tone="secondary" size="compact" onClick={onClose}>
            取消
          </IosButton>
          <IosButton
            tone="primary"
            size="compact"
            onClick={() => {
              saveMarks(draft.marks)
              saveCustomModels(draft.custom)
              onClose()
            }}
          >
            保存
          </IosButton>
        </div>
      </div>
    </div>
  )
}

const copyBtnStyle: preact.JSX.CSSProperties = {
  appearance: 'none',
  border: '1px solid #c8c8cd',
  background: 'linear-gradient(180deg, #fdfdfd 0%, #ececef 100%)',
  borderRadius: 4,
  padding: '2px 6px',
  fontSize: 10,
  cursor: 'pointer',
  color: '#4a4a4f',
}

function NewCustomModelForm({
  onCreate,
  onCancel,
}: {
  onCreate: (name: string, price: { input: number; output: number; cacheInput: number }) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [input, setInput] = useState('1.0')
  const [output, setOutput] = useState('3.0')
  const [cache, setCache] = useState('0.1')

  return (
    <div
      style={{
        marginTop: 12,
        padding: 10,
        border: '1px solid #d8d8de',
        borderRadius: 6,
        background: '#fafafc',
        display: 'grid',
        gridTemplateColumns: '2fr 1fr 1fr 1fr auto',
        gap: 6,
        alignItems: 'center',
      }}
    >
      <input
        class="ios-text-field"
        type="text"
        placeholder="模型名（如 my-gpt-4o）"
        value={name}
        onInput={(e) => setName((e.target as HTMLInputElement).value.trim())}
      />
      <input
        class="ios-text-field"
        type="number"
        step="0.01"
        min="0"
        title="输入价 ¥/1M"
        value={input}
        onInput={(e) => setInput((e.target as HTMLInputElement).value)}
      />
      <input
        class="ios-text-field"
        type="number"
        step="0.01"
        min="0"
        title="输出价 ¥/1M"
        value={output}
        onInput={(e) => setOutput((e.target as HTMLInputElement).value)}
      />
      <input
        class="ios-text-field"
        type="number"
        step="0.01"
        min="0"
        title="缓存读价 ¥/1M"
        value={cache}
        onInput={(e) => setCache((e.target as HTMLInputElement).value)}
      />
      <div style={{ display: 'flex', gap: 4 }}>
        <IosButton
          tone="primary"
          size="compact"
          onClick={() => {
            const inP = Number(input)
            const outP = Number(output)
            const caP = Number(cache)
            if (!name || !Number.isFinite(inP) || !Number.isFinite(outP) || !Number.isFinite(caP)) return
            if (inP < 0 || outP < 0 || caP < 0) return
            onCreate(name, { input: inP, output: outP, cacheInput: caP })
            setName('')
            setInput('1.0')
            setOutput('3.0')
            setCache('0.1')
          }}
        >
          添加
        </IosButton>
        <IosButton tone="secondary" size="compact" onClick={onCancel}>
          取消
        </IosButton>
      </div>
    </div>
  )
}

// ---- 表格列 ----

const columns = [
  {
    key: 'model',
    header: '模型分组',
    width: '220px',
    render: (r: GroupedModelRow) => {
      const tagged = isMarkedModel(r.groupKey) || r.modelIds.some((id) => isMarkedModel(id))
      return (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {r.groupKey}
            {tagged ? (
              <span
                title="已标记：用户手动指定了计价模型"
                style={tagStyle('#1f6f43', '#d4f4e1')}
              >
                已标记
              </span>
            ) : r.recognized ? (
              <span
                title="价目表里能精确匹配到模型"
                style={tagStyle('#1f6f43', '#d4f4e1')}
              >
                已识别
              </span>
            ) : (
              <span
                title="未命中价目表，成本按 v4-pro 默认价估算"
                style={tagStyle('#fff', '#9aa0a6')}
              >
                未识别
              </span>
            )}
            {r.merged && (
              <span
                title={`该组合并了 ${r.modelIds.length} 个 model_id`}
                style={tagStyle('#fff', '#8e8e93')}
              >
                {r.modelIds.length} 个ID
              </span>
            )}
          </span>
          {r.merged && (
            <span style={{ fontSize: 10, color: '#8a8a90' }} class="mono">
              {r.modelIds.join(' · ')}
            </span>
          )}
        </div>
      )
    },
  },
  {
    key: 'calls',
    header: '调用',
    align: 'right' as const,
    width: '70px',
    render: (r: GroupedModelRow) => formatCount(r.calls),
  },
  {
    key: 'total',
    header: '总 token',
    align: 'right' as const,
    width: '90px',
    render: (r: GroupedModelRow) => formatCount(r.totalTokens),
  },
  {
    key: 'in',
    header: '输入',
    align: 'right' as const,
    width: '80px',
    render: (r: GroupedModelRow) => formatCount(r.inputTokens),
  },
  {
    key: 'cache_w',
    header: '缓存写',
    align: 'right' as const,
    width: '80px',
    render: (r: GroupedModelRow) => formatCount(r.cacheCreationTokens),
  },
  {
    key: 'cache_r',
    header: '缓存读',
    align: 'right' as const,
    width: '80px',
    render: (r: GroupedModelRow) => formatCount(r.cacheReadTokens),
  },
  {
    key: 'cache_hit',
    header: '缓存命中率',
    align: 'right' as const,
    width: '90px',
    render: (r: GroupedModelRow) => formatPct(r.cacheHitRate, 1),
  },
  {
    key: 'out',
    header: '输出',
    align: 'right' as const,
    width: '70px',
    render: (r: GroupedModelRow) => formatCount(r.outputTokens),
  },
  {
    key: 'reason',
    header: 'Reasoning',
    align: 'right' as const,
    width: '80px',
    render: (r: GroupedModelRow) => formatCount(r.reasoningTokens),
  },
  {
    key: 'cost',
    header: '大致成本',
    align: 'right' as const,
    width: '95px',
    render: (r: GroupedModelRow) => formatRMB(r.cost),
  },
  {
    key: 'err',
    header: '错误',
    align: 'right' as const,
    width: '70px',
    render: (r: GroupedModelRow) => (r.errorCount > 0 ? formatCount(r.errorCount) : '—'),
  },
]

function tagStyle(fg: string, bg: string): preact.JSX.CSSProperties {
  return {
    fontSize: 9,
    fontWeight: 700,
    color: fg,
    background: bg,
    borderRadius: 6,
    padding: '1px 5px',
    lineHeight: 1.4,
  }
}
