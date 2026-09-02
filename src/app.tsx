import { useEffect, useState } from 'preact/hooks'
import { IosButton } from './ui/ios-button.tsx'
import { useDb } from './db/client.ts'
import { ROUTES, useRoute, type RouteName } from './lib/router.ts'
import { formatFileSize } from './lib/format.ts'
import { OverviewPage } from './pages/overview.tsx'
import { ByProviderPage } from './pages/by-provider.tsx'
import { ProviderDetailPage } from './pages/provider-detail.tsx'
import { ProviderModelDetailPage } from './pages/provider-model-detail.tsx'
import { ByModelPage } from './pages/by-model.tsx'
import { ModelDetailPage } from './pages/model-detail.tsx'
import { ByDayPage } from './pages/by-day.tsx'
import { BySessionPage } from './pages/by-session.tsx'
import { ByHourPage } from './pages/by-hour.tsx'
import { ByToolPage } from './pages/by-tool.tsx'
import { ByPromptPage } from './pages/by-prompt.tsx'
import { ErrorsPage } from './pages/errors.tsx'
import { SqlConsolePage } from './pages/sql-console.tsx'
import { AboutPage } from './pages/about.tsx'
import { EmptyState } from './ui/empty-state.tsx'

export function App() {
  const { route, param } = useRoute()
  const { state, openDroppedFile, pickAndOpen, close } = useDb()

  // 全屏 drag/drop：Finder 拖 db.sqlite 到任意位置都接。
  const [dragHover, setDragHover] = useState(false)
  const [replaceCandidate, setReplaceCandidate] = useState<File | null>(null)
  // 第一次点 "打开 db.sqlite" 时先弹 OS 路径说明，避免用户去找隐藏目录。
  const [showPathHint, setShowPathHint] = useState(false)

  useEffect(() => {
    const onDragOver = (ev: DragEvent) => {
      if (!ev.dataTransfer) return
      // 仅当拖的是文件时才高亮
      const hasFile = Array.from(ev.dataTransfer.items ?? []).some(
        (it) => it.kind === 'file',
      )
      if (!hasFile) return
      ev.preventDefault()
      ev.dataTransfer.dropEffect = 'copy'
      setDragHover(true)
    }
    const onDragLeave = (ev: DragEvent) => {
      // 鼠标真正离开窗口时才取消高亮（relatedTarget 落到 null 或外层文档）
      if (ev.relatedTarget === null) setDragHover(false)
    }
    const onDrop = (ev: DragEvent) => {
      ev.preventDefault()
      setDragHover(false)
      const file = ev.dataTransfer?.files?.[0]
      if (!file) return
      if (state.kind === 'ready') {
        // 已开着 db，先弹确认
        setReplaceCandidate(file)
      } else {
        void openDroppedFile(file).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          window.alert(msg)
        })
      }
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [state.kind, openDroppedFile])

  const confirmReplace = () => {
    const file = replaceCandidate
    setReplaceCandidate(null)
    if (!file) return
    close()
    void openDroppedFile(file).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      window.alert(msg)
    })
  }

  return (
    <div class="app-shell">
      <div class="app-topbar">
        <div class="app-topbar__title">ZCode 用量分析</div>
        {state.kind === 'ready' && (
          <div class="app-topbar__file" title={state.db.file.name}>
            {state.db.file.name} · {formatFileSize(state.db.size)}
          </div>
        )}
        <div class="app-topbar__spacer" />
        {state.kind === 'ready' ? (
          <IosButton tone="secondary" size="compact" onClick={close}>
            关闭文件
          </IosButton>
        ) : (
          <div class="app-topbar__actions">
            <IosButton
              tone="primary"
              size="compact"
              onClick={() => setShowPathHint(true)}
              disabled={state.kind === 'picking' || state.kind === 'opening'}
            >
              {state.kind === 'picking'
                ? '选择文件中…'
                : state.kind === 'opening'
                  ? '加载中…'
                  : '打开 db.sqlite'}
            </IosButton>
          </div>
        )}
      </div>

      <aside class="app-sidebar">
        {ROUTES.filter((r) => r.showInNav).map((r) => {
          const active = route === r.path
          return (
            <button
              key={r.path}
              type="button"
              class={`app-nav-item${active ? ' app-nav-item--active' : ''}`}
              onClick={() => {
                window.location.hash = `#/${r.path}`
              }}
            >
              {r.title}
            </button>
          )
        })}
      </aside>

      <main class="app-main">
        <PageHost route={route} param={param} state={state} />
      </main>

      {dragHover && (
        <div class="app-drop-overlay">
          <div class="app-drop-overlay__panel">
            <div class="app-drop-overlay__icon">📄</div>
            <div class="app-drop-overlay__title">松手打开 db.sqlite</div>
            <div class="app-drop-overlay__sub">从 Finder 拖入 SQLite 数据库文件</div>
          </div>
        </div>
      )}

      {replaceCandidate && (
        <div class="app-modal" role="dialog" aria-modal="true">
          <div class="app-modal__panel">
            <div class="app-modal__title">替换当前数据库？</div>
            <div class="app-modal__body">
              当前已打开 <strong>{state.kind === 'ready' ? state.db.file.name : ''}</strong>，
              将被 <strong>{replaceCandidate.name}</strong> 替换。
            </div>
            <div class="app-modal__actions">
              <IosButton tone="secondary" size="compact" onClick={() => setReplaceCandidate(null)}>
                取消
              </IosButton>
              <IosButton tone="primary" size="compact" onClick={confirmReplace}>
                替换
              </IosButton>
            </div>
          </div>
        </div>
      )}

      {showPathHint && (
        <div class="app-modal" role="dialog" aria-modal="true">
          <div class="app-modal__panel" style={{ minWidth: 460, maxWidth: 560 }}>
            <div class="app-modal__title">选择 db.sqlite</div>
            <div class="app-modal__body">
              <p style={{ marginTop: 0 }}>ZCode 的数据库文件位置：</p>
              <div
                class="mono"
                style={{
                  fontSize: 12,
                  background: 'linear-gradient(180deg, #fafafb 0%, #f0f0f3 100%)',
                  border: '1px solid #d0d0d4',
                  borderRadius: 6,
                  padding: '8px 10px',
                  margin: '4px 0 10px',
                  wordBreak: 'break-all',
                }}
              >
                <div><strong>macOS / Linux：</strong> ~/.zcode/cli/db/db.sqlite</div>
                <div style={{ marginTop: 4 }}><strong>Windows：</strong> %USERPROFILE%\.zcode\cli\db\db.sqlite</div>
              </div>
              <ul style={{ margin: '4px 0 0 18px', padding: 0, fontSize: 12, lineHeight: 1.6 }}>
                <li>macOS 系统选择器默认不显示隐藏目录，按 <strong>⌘Shift+.</strong> 切换显示。</li>
                <li><strong>建议：</strong>直接在 Finder 选中文件，<strong>拖进浏览器窗口</strong> — 最稳。</li>
                <li>若 ZCode 正在运行，WAL 可能还在写：建议先 ⌘Q 退出 ZCode，或在终端跑
                  <code style={{ fontSize: 11 }}> sqlite3 ~/.zcode/cli/db/db.sqlite .quit </code>
                  触发 checkpoint（部分版本即使在 ZCode 运行中也能读到，取决于 WAL 状态）。</li>
              </ul>
            </div>
            <div class="app-modal__actions">
              <IosButton tone="secondary" size="compact" onClick={() => setShowPathHint(false)}>
                取消
              </IosButton>
              <IosButton
                tone="primary"
                size="compact"
                onClick={() => {
                  setShowPathHint(false)
                  void pickAndOpen()
                }}
              >
                选择文件
              </IosButton>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PageHost({
  route,
  param,
  state,
}: {
  route: RouteName
  param: string
  state: ReturnType<typeof useDb>['state']
}) {
  // 「关于」不需要数据库,任何状态下都能进
  if (route === 'about') {
    return <AboutPage />
  }
  if (state.kind !== 'ready') {
    return <IdleView state={state} />
  }
  switch (route) {
    case 'overview':
      return <OverviewPage db={state.db} />
    case 'by-provider':
      return <ByProviderPage db={state.db} />
    case 'provider':
      return <ProviderDetailPage db={state.db} providerId={param} />
    case 'provider-model': {
      const [providerId, modelId] = param.split('/')
      return providerId && modelId ? (
        <ProviderModelDetailPage db={state.db} providerId={providerId} modelId={modelId} />
      ) : null
    }
    case 'by-model':
      return <ByModelPage db={state.db} />
    case 'model':
      return <ModelDetailPage db={state.db} group={param} />
    case 'by-day':
      return <ByDayPage db={state.db} />
    case 'by-session':
      return <BySessionPage db={state.db} />
    case 'by-hour':
      return <ByHourPage db={state.db} />
    case 'by-tool':
      return <ByToolPage db={state.db} />
    case 'by-prompt':
      return <ByPromptPage db={state.db} />
    case 'errors':
      return <ErrorsPage db={state.db} />
    case 'sql':
      return <SqlConsolePage db={state.db} />
    case 'about':
      return <AboutPage />
    default:
      return null
  }
}

function IdleView({ state }: { state: ReturnType<typeof useDb>['state'] }) {
  if (state.kind === 'error') {
    return (
      <div class="page">
        <h1 class="page__title">打不开这个数据库</h1>
        {state.fileName && <p class="page__subtitle mono">{state.fileName}</p>}
        <div class="app-banner app-banner--error">
          <div>
            <div class="app-banner__title">错误</div>
            <div>{state.error}</div>
            <div style={{ marginTop: '8px' }}>
              <strong>常见原因：</strong>
              <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                <li>ZCode 还在运行中（WAL 可能被占用）— 建议先 ⌘Q 退出 ZCode，或在终端跑 <code>sqlite3 ~/.zcode/cli/db/db.sqlite .quit</code> 触发 checkpoint；部分版本可直接读到。</li>
                <li>选了非 SQLite 文件 — 请确认选的是 ZCode 的 <code>~/.zcode/cli/db/db.sqlite</code>。</li>
                <li>浏览器版本太老（需要 Chrome 86+ / Edge 86+ / Firefox 111+ / Safari 16.4+）。</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div class="page">
      <EmptyState
        title="还没选文件"
        description={`两种方式打开 ZCode 的 db.sqlite：
1) 直接从 Finder / 资源管理器拖 db.sqlite 进来 — 最稳；
2) 点右上角 "打开 db.sqlite"，按提示找到隐藏目录 ~/.zcode/cli/db/（macOS 选目录时按 ⌘Shift+.）。

ZCode 运行中通常也能打开（immutable=1 跳过锁），但 WAL 里未 checkpoint 的最新数据可能读不到 — 想要最新数据建议先 ⌘Q 退出 ZCode。`}
      />
    </div>
  )
}
