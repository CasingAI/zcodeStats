// Main-thread client that spawns the worker, hands it the chosen File handle,
// and exposes a small `select()` RPC plus a React-style hook for consumers.
//
// 自愈机制：ZCode 会持续写 db.sqlite（WAL + checkpoint），浏览器对选中/拖入的
// File 记录了打开时刻的快照（size+mtime），文件一变，之后的读取会被 Chromium
// 拒绝（NotReadableError），worker 的 VFS xRead 把它翻译成 SQLITE_IOERR(10)。
// 因此 select 捕获 IOERR 后自动 handle.getFile() 取新快照、换新 worker 重开并
// 重放查询，对页面透明。

import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type {
  SqlExecResult,
  ThinkingArgs,
  ThinkingProgress,
  ThinkingResult,
} from './types.ts'

type SelectArgs = {
  sql: string
  bind?: unknown[]
}

type WorkerInput =
  | { id: number; op: 'open'; args: { file: File; filename: string } }
  | { id: number; op: 'select'; args: SelectArgs }
  | { id: number; op: 'thinking'; args: ThinkingArgs }
  | { id: number; op: 'thinkingAbort'; args: { targetId: number } }
  | { id: number; op: 'close' }

type WorkerOutput =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: true; progress: ThinkingProgress }
  | { id: number; ok: false; error: string }

/** 在途请求的回调集。进度消息不消费条目，等最终结果才移除。 */
type PendingRpc = {
  resolve: (r: unknown) => void
  reject: (e: Error) => void
  onProgress?: (p: ThinkingProgress) => void
}

/** showOpenFilePicker / getAsFileSystemHandle 返回句柄的最小结构化接口。 */
export type FsFileHandle = { getFile: () => Promise<File> }

export type PickedSqliteFile = { file: File; handle: FsFileHandle | null }

export type OpenedDb = {
  file: File
  size: number
  /** 关闭 + 终止 worker */
  close: () => void
  select: (sql: string, bind?: unknown[]) => Promise<{ columns: string[]; rows: unknown[][] }>
  /** 思考页聚合 + GLM 思考原文精确计数。进度经 onProgress 透传；
   *  abort 请求中止当前计数（结果仍会返回，exact=false 表示不完整）。 */
  thinking: (
    args: ThinkingArgs,
    onProgress?: (p: ThinkingProgress) => void,
  ) => { result: Promise<ThinkingResult>; abort: () => void }
}

// worker VFS xRead 短读/抛错时 SQLite 上报的错误（result code 10）。
const IOERR_RE = /SQLITE_IOERR|disk I\/O error/i
// 本文件内部标记：worker 已被替换/终止，该请求要走自愈重试而不是报给用户。
const STALE = 'STALE_WORKER'
const NEED_REOPEN =
  '数据文件已被修改，浏览器缓存的文件快照已失效，且本次打开方式无法自动恢复。请重新拖入 db.sqlite，或点右上角重新选择。'

/** 选文件（优先 showOpenFilePicker，回退 input[type=file]）。Chromium 下返回的 handle 之后可用于重取快照。 */
export async function pickSqliteFile(): Promise<PickedSqliteFile | null> {
  // 1) 优先：File System Access API（仅 Chromium 系）
  const sap = (window as unknown as { showOpenFilePicker?: (opts: unknown) => Promise<unknown[]> })
    .showOpenFilePicker
  if (sap) {
    try {
      const handles = (await sap({
        types: [
          {
            description: 'SQLite database',
            accept: { 'application/octet-stream': ['.db', '.sqlite', '.sqlite3'] },
          },
        ],
        multiple: false,
        excludeAcceptAllOption: false,
      })) as Array<FsFileHandle>
      if (handles && handles.length > 0 && handles[0]) {
        const handle = handles[0]
        // getFile() 快照的是"此刻"的文件；之后 ZCode 再写入，就要靠 select 的自愈重新 getFile。
        return { file: await handle.getFile(), handle }
      }
      return null
    } catch (err) {
      // 用户取消走 AbortError，落回 input
      if (err instanceof Error && err.name === 'AbortError') return null
      console.warn('showOpenFilePicker failed, falling back to <input>', err)
    }
  }
  // 2) 兜底：临时 <input type=file>（拿不到 handle，快照失效时只能提示重选）
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.db,.sqlite,.sqlite3,application/octet-stream'
    input.style.position = 'fixed'
    input.style.left = '-10000px'
    input.addEventListener(
      'change',
      () => {
        const f = input.files?.[0] ?? null
        document.body.removeChild(input)
        resolve(f ? { file: f, handle: null } : null)
      },
      { once: true },
    )
    document.body.appendChild(input)
    input.click()
  })
}

/**
 * spawn worker，open 文件，返回 OpenedDb 句柄。
 * select 遇到 IOERR / worker 被替换时自动取新快照重开并重放，对调用方透明。
 */
export function openDb(file: File, handle: FsFileHandle | null = null): Promise<OpenedDb> {
  return new Promise((resolve, reject) => {
    let worker: Worker | null = null
    let pending = new Map<number, PendingRpc>()
    let nextId = 1
    let closed = false
    let currentFile = file
    let healSeq = 0
    let healPromise: Promise<void> | null = null

    const terminate = () => {
      const w = worker
      worker = null
      if (w) w.terminate()
      // 在途 RPC 立刻失败（select 判定 STALE 走重试），避免挂死。
      for (const entry of pending.values()) entry.reject(new Error(STALE))
      pending = new Map()
    }

    const sendRaw = <T>(
      op: WorkerInput['op'],
      args: unknown,
      onProgress?: (p: ThinkingProgress) => void,
    ): { id: number; promise: Promise<T> } => {
      const w = worker
      if (!w) return { id: -1, promise: Promise.reject(new Error(STALE)) }
      const id = nextId
      nextId += 1
      const promise = new Promise<T>((res, rej) => {
        pending.set(id, { resolve: res as (r: unknown) => void, reject: rej, onProgress })
      })
      // File 不是 transferable（仅 ArrayBuffer / MessagePort / ReadableStream
      // 等少数类型可 transfer）。走 structured clone：浏览器对 File 只克隆
      // 元数据 + 句柄引用，文件体仍 lazy 读取，GB 级文件不会真复制。
      const w2 = { id, op, args } as WorkerInput
      w.postMessage(w2)
      return { id, promise }
    }

    const spawn = () => {
      terminate()
      const w = new Worker(new URL('./worker.ts', import.meta.url), {
        type: 'module',
        name: 'zcode-stats-sqlite',
      })
      worker = w
      w.addEventListener('message', (ev: MessageEvent<WorkerOutput>) => {
        const msg = ev.data
        if (!msg || typeof msg.id !== 'number') return
        const entry = pending.get(msg.id)
        if (!entry) return
        if (!msg.ok) {
          pending.delete(msg.id)
          entry.reject(new Error(msg.error))
          return
        }
        // 进度消息不消费 pending：同一请求稍后还会来最终结果
        if ('progress' in msg) {
          entry.onProgress?.(msg.progress)
          return
        }
        pending.delete(msg.id)
        entry.resolve(msg.result)
      })
      w.addEventListener('error', () => terminate())
    }

    const openOn = (f: File) =>
      sendRaw<{ size: number }>('open', { file: f, filename: f.name || 'db.sqlite' }).promise

    // 单飞自愈：并发失败的 select 共享同一次重开。必须换全新 worker（而不是给
    // 旧 worker 重新 open）：旧 worker 的 SQLite page cache 里混着旧快照的页，
    // 只有整体重建才能保证读到一致的新快照。
    const heal = (): Promise<void> => {
      if (healPromise) return healPromise
      const run = async (): Promise<void> => {
        if (closed) throw new Error('数据库已关闭')
        if (!handle) throw new Error(NEED_REOPEN)
        const fresh = await handle.getFile()
        currentFile = fresh
        spawn()
        await openOn(fresh)
        // 自愈期间用户可能点了「关闭文件」：别把新开的 worker 泄漏在后台。
        if (closed) {
          terminate()
          throw new Error('数据库已关闭')
        }
        healSeq += 1
        console.info(
          `[zcode-stats] db.sqlite 正在被 ZCode 写入，文件快照已失效，自动重取新快照（第 ${healSeq} 次）`,
        )
      }
      healPromise = run().finally(() => {
        healPromise = null
      })
      return healPromise
    }

    // 最多 3 次尝试（2 次自愈），防止 ZCode 高频写入时无限循环。
    const select: OpenedDb['select'] = async (sql, bind) => {
      let lastErr: Error = new Error('select not attempted')
      for (let attempt = 0; ; attempt += 1) {
        if (closed) throw new Error('数据库已关闭')
        try {
          return await sendRaw<{ columns: string[]; rows: unknown[][] }>('select', { sql, bind })
            .promise
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err))
          if (!IOERR_RE.test(lastErr.message) && lastErr.message !== STALE) throw lastErr
        }
        if (attempt >= 2) throw lastErr
        await heal()
      }
    }

    // 「思考」聚合：进度透传 + 与 select 同款自愈（计数有 tokenCache，
    // 重放只补未数过的部分，代价低）。
    const thinking: OpenedDb['thinking'] = (args, onProgress) => {
      let currentId: number | null = null
      const result = (async (): Promise<ThinkingResult> => {
        let lastErr: Error = new Error('thinking not attempted')
        for (let attempt = 0; ; attempt += 1) {
          if (closed) throw new Error('数据库已关闭')
          const { id, promise } = sendRaw<ThinkingResult>('thinking', args, onProgress)
          currentId = id
          try {
            return await promise
          } catch (err) {
            lastErr = err instanceof Error ? err : new Error(String(err))
            if (!IOERR_RE.test(lastErr.message) && lastErr.message !== STALE) throw lastErr
          }
          if (attempt >= 2) throw lastErr
          await heal()
        }
      })()
      return {
        result,
        abort: () => {
          const id = currentId
          if (id == null || id < 0) return
          void sendRaw('thinkingAbort', { targetId: id }).promise.catch(() => {
            /* worker 已被替换/关闭：无需处理 */
          })
        },
      }
    }

    const close = () => {
      closed = true
      terminate()
    }

    spawn()
    openOn(file)
      .then(() => {
        resolve({
          get file() {
            return currentFile
          },
          get size() {
            return currentFile.size
          },
          close,
          select,
          thinking,
        })
      })
      .catch((err) => {
        terminate()
        reject(err)
      })
  })
}

// ----- React-style hook (Preact) for the open-db state -----

export type DbState =
  | { kind: 'idle' }
  | { kind: 'picking' }
  | { kind: 'opening'; fileName: string }
  | { kind: 'ready'; db: OpenedDb }
  | { kind: 'error'; error: string; fileName?: string }

export function useDb() {
  const [state, setState] = useState<DbState>({ kind: 'idle' })
  const dbRef = useRef<OpenedDb | null>(null)

  const open = useCallback(async (file: File, handle: FsFileHandle | null = null) => {
    setState({ kind: 'opening', fileName: file.name })
    const openWithRetry = async (): Promise<OpenedDb> => {
      try {
        return await openDb(file, handle)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // 选完到打开之间文件恰好被 ZCode 写了一笔：取新快照重试一次。
        if (!(handle && IOERR_RE.test(msg))) throw err
        const fresh = await handle.getFile()
        setState({ kind: 'opening', fileName: fresh.name })
        return openDb(fresh, handle)
      }
    }
    try {
      const db = await openWithRetry()
      dbRef.current = db
      setState({ kind: 'ready', db })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setState({ kind: 'error', error: msg, fileName: file.name })
    }
  }, [])

  /** 拖放专用：先校验文件名是 .sqlite 家族，否则抛错。 */
  const openDroppedFile = useCallback(
    async (file: File, handle: FsFileHandle | null = null) => {
      const lower = file.name.toLowerCase()
      if (!(lower.endsWith('.sqlite') || lower.endsWith('.db') || lower.endsWith('.sqlite3'))) {
        throw new Error(`不是 SQLite 文件：${file.name}。请拖入 db.sqlite 或类似 .sqlite/.db 文件。`)
      }
      await open(file, handle)
    },
    [open],
  )

  const pickAndOpen = useCallback(async () => {
    setState({ kind: 'picking' })
    try {
      const picked = await pickSqliteFile()
      if (!picked) {
        setState({ kind: 'idle' })
        return
      }
      await open(picked.file, picked.handle)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setState({ kind: 'error', error: msg })
    }
  }, [open])

  const close = useCallback(() => {
    if (dbRef.current) {
      dbRef.current.close()
      dbRef.current = null
    }
    setState({ kind: 'idle' })
  }, [])

  // 卸载时自动关闭
  useEffect(() => {
    return () => {
      if (dbRef.current) dbRef.current.close()
    }
  }, [])

  return { state, open, openDroppedFile, pickAndOpen, close }
}

// Convenience for raw SQL console: run a query and return the full result
// in the same shape our SqlExecResult type expects.
export async function runSql(
  db: OpenedDb,
  sql: string,
  bind?: unknown[],
): Promise<SqlExecResult> {
  const start = performance.now()
  const r = await db.select(sql, bind)
  return {
    columns: r.columns,
    rows: r.rows,
    rowsAffected: 0,
    lastInsertRowid: null,
    durationMs: Math.round(performance.now() - start),
  }
}
