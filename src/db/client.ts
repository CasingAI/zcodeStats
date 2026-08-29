// Main-thread client that spawns the worker, hands it the chosen File handle,
// and exposes a small `select()` RPC plus a React-style hook for consumers.

import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { SqlExecResult } from './types.ts'

type SelectArgs = {
  sql: string
  bind?: unknown[]
}

type WorkerInput =
  | { id: number; op: 'open'; args: { file: File; filename: string } }
  | { id: number; op: 'select'; args: SelectArgs }
  | { id: number; op: 'close' }

type WorkerOutput =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }

export type OpenedDb = {
  file: File
  size: number
  /** 关闭 + 终止 worker */
  close: () => void
  select: (sql: string, bind?: unknown[]) => Promise<{ columns: string[]; rows: unknown[][] }>
}

/** 选文件（优先 showOpenFilePicker，回退 input[type=file]） */
export async function pickSqliteFile(): Promise<File | null> {
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
      })) as Array<{ getFile: () => Promise<File> }>
      if (handles && handles.length > 0 && handles[0]) {
        return await handles[0].getFile()
      }
      return null
    } catch (err) {
      // 用户取消走 AbortError，落回 input
      if (err instanceof Error && err.name === 'AbortError') return null
      console.warn('showOpenFilePicker failed, falling back to <input>', err)
    }
  }
  // 2) 兜底：临时 <input type=file>
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
        resolve(f)
      },
      { once: true },
    )
    document.body.appendChild(input)
    input.click()
  })
}

/** spawn worker，open 文件，返回 OpenedDb 句柄 */
export function openDb(file: File): Promise<OpenedDb> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'zcode-stats-sqlite',
    })
    let nextId = 1
    const pending = new Map<number, (r: WorkerOutput) => void>()
    const ready = { resolved: false }

    worker.addEventListener('message', (ev: MessageEvent<WorkerOutput>) => {
      const msg = ev.data
      if (!msg || typeof msg.id !== 'number') return
      const cb = pending.get(msg.id)
      if (cb) {
        pending.delete(msg.id)
        cb(msg)
      }
    })
    worker.addEventListener('error', (ev) => {
      reject(new Error(`worker error: ${ev.message}`))
    })

    const send = <T>(op: WorkerInput['op'], args: unknown): Promise<T> => {
      const id = nextId
      nextId += 1
      return new Promise<T>((res, rej) => {
        pending.set(id, (r) => {
          if (r.ok) res(r.result as T)
          else rej(new Error(r.error))
        })
        // File 不是 transferable（仅 ArrayBuffer / MessagePort / ReadableStream
        // 等少数类型可 transfer）。走 structured clone：浏览器对 File 只克隆
        // 元数据 + 句柄引用，文件体仍 lazy 读取，932MB 不会真复制。
        const w = { id, op, args } as WorkerInput
        worker.postMessage(w)
      })
    }

    const filename = file.name || 'db.sqlite'
    send<{ size: number }>('open', { file, filename })
      .then((r) => {
        ready.resolved = true
        resolve({
          file,
          size: r.size,
          close: () => {
            try {
              send('close', undefined).catch(() => undefined)
            } finally {
              worker.terminate()
            }
          },
          select: (sql: string, bind?: unknown[]) =>
            send<{ columns: string[]; rows: unknown[][] }>('select', { sql, bind }),
        })
      })
      .catch((err) => {
        worker.terminate()
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

  const open = useCallback(async (file: File) => {
    setState({ kind: 'opening', fileName: file.name })
    try {
      const db = await openDb(file)
      dbRef.current = db
      setState({ kind: 'ready', db })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setState({ kind: 'error', error: msg, fileName: file.name })
    }
  }, [])

  /** 拖放专用：先校验文件名是 .sqlite 家族，否则抛错。 */
  const openDroppedFile = useCallback(async (file: File) => {
    const lower = file.name.toLowerCase()
    if (!(lower.endsWith('.sqlite') || lower.endsWith('.db') || lower.endsWith('.sqlite3'))) {
      throw new Error(`不是 SQLite 文件：${file.name}。请拖入 db.sqlite 或类似 .sqlite/.db 文件。`)
    }
    await open(file)
  }, [open])

  const pickAndOpen = useCallback(async () => {
    setState({ kind: 'picking' })
    try {
      const file = await pickSqliteFile()
      if (!file) {
        setState({ kind: 'idle' })
        return
      }
      await open(file)
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
