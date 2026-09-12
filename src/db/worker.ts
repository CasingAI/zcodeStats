/// <reference lib="webworker" />
// Web Worker that owns the sqlite3 WASM engine and exposes a `select` RPC
// to the main thread. The custom VFS reads bytes lazily from a `File` handle
// via FileReaderSync (synchronous File I/O, available only inside workers).
//
// VFS contract notes (all verified against sqlite3-wasm's own OPFS VFS):
// - The vfs struct MUST set $iVersion / $szOsFile / $mxPathname before
//   registration; a zeroed struct breaks every later open.
// - xOpen MUST write the io-methods pointer into sqlite3_file (offset 0)
//   and MUST write the actual flags to *pOutFlags.
// - Out-pointer arguments (xAccess/xCheckReservedLock) are 4-byte ints,
//   not single bytes.
// - xRead's iOfst is sqlite3_int64 and arrives as a BigInt.
// - xCurrentTime writes a float64 (days), xCurrentTimeInt64 a int64.
// - xRead must zero-fill the buffer, especially on short reads past EOF.
// - xDelete is a no-op returning SQLITE_OK (SQLite deletes absent WAL
//   files during the readonly downgrade path).

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
// Vite's ?url import gives us the hashed asset URL of the wasm file at build
// time. Without this, sqlite3InitModule's default locateFile would 404 because
// the file is emitted as `sqlite3-HASH.wasm`, not `sqlite3.wasm`.
import sqlite3WasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url'
import { GlmTokenCounter, GLM_MODEL_PREFIX, TOKENIZER_URL } from '../lib/glm-tokenizer.ts'
import { trendBucketExpr } from './queries.ts'
import type { ThinkingArgs, ThinkingProgress, ThinkingResult, ThinkingRow } from './types.ts'

type ExecArgs = {
  sql: string
  bind?: unknown[]
}

type OpenArgs = {
  file: File | null
  filename: string
}

type WorkerInput =
  | { id: number; op: 'open'; args: OpenArgs }
  | { id: number; op: 'select'; args: ExecArgs }
  | { id: number; op: 'thinking'; args: ThinkingArgs }
  | { id: number; op: 'thinkingAbort'; args: { targetId: number } }
  | { id: number; op: 'close' }

type WorkerOutput =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: true; progress: ThinkingProgress }
  | { id: number; ok: false; error: string }

const SQLITE_OK = 0
const SQLITE_READONLY = 8
const SQLITE_IOERR_READ = 10
const SQLITE_OPEN_READONLY = 0x01

const DEBUG_VFS_TRACE = false

let sqlite3: any = null
let db: any = null
let openFileHandle: File | null = null
let openFileName = ''
let openFileSize = 0
let ioMethodsPtr = 0

// ---- 思考聚合（op: thinking）的模块级状态 ----

// GLM 官方分词器（20MB JSON）：首次 thinking 时 fetch + 解析，worker 存活期复用。
let tokenizerPromise: Promise<GlmTokenCounter> | null = null
// part_id → token 数。跨范围/跨页面复用计数结果；换数据库文件时清空。
const tokenCache = new Map<string, number>()
// 同一时间只保留最新一个 thinking 任务：新任务到达时旧任务在批次边界自动停止。
let activeThinkingId: number | null = null
const thinkingAbortIds = new Set<number>()

function getTokenizer(): Promise<GlmTokenCounter> {
  if (!tokenizerPromise) {
    tokenizerPromise = fetch(TOKENIZER_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`加载 GLM 分词器失败: HTTP ${res.status}`)
        return res.json() as Promise<unknown>
      })
      .then((json) => new GlmTokenCounter(json))
      .catch((err: unknown) => {
        // 复位以便下次重试
        tokenizerPromise = null
        throw err
      })
  }
  return tokenizerPromise
}

/** 本地时区小时桶 'YYYY-MM-DDTHH'（与 trendBucketExpr('hour') 同口径，JS 侧实现） */
function hourBucketKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string') return Number(v) || 0
  return 0
}

function toNumOrNull(v: unknown): number | null {
  if (v == null) return null
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isNaN(n) ? null : n
  }
  return null
}

function toStrOrNull(v: unknown): string | null {
  return v == null ? null : String(v)
}

// GLM 文本分批计数：批间让出消息循环，其他页面的 select 得以穿插处理。
const THINK_BATCH_SIZE = 50

/**
 * 「思考」聚合：扫描 part 表的思考片段（全模型），按「本地小时桶 × 模型」聚合
 * 段数/时长/字符数并收集 GLM 系原文；GLM 原文用官方分词器分批精确计数
 * （带进度、可中止、结果入 tokenCache）；再叠加 model_usage 里接口报数的
 * reasoning_tokens，合并成一份行集返回。思考原文不离开 worker，只回传数字。
 */
async function runThinking(reqId: number, from: number, to: number): Promise<ThinkingResult> {
  // ① 单遍扫描 part × message。LIKE 预过滤让非思考行（约 8 成）不进 JSON 解析；
  //    part 表无时间索引，范围过滤在此发生（全表扫描一次）。
  //    GLM 原文用 CASE 短路取值：非 GLM 行不提取 text，扫描更省。
  const scanSql = `
    SELECT p.id AS id,
           p.time_created AS timeCreated,
           json_extract(p.data,'$.time.start') AS tStart,
           json_extract(p.data,'$.time.end') AS tEnd,
           CASE WHEN json_extract(m.data,'$.modelID') LIKE '${GLM_MODEL_PREFIX}%'
                THEN json_extract(p.data,'$.text') END AS glmText,
           json_extract(m.data,'$.modelID') AS modelId
    FROM part p JOIN message m ON m.id = p.message_id
    WHERE p.data LIKE '{"type":"reasoning"%'
      AND p.time_created >= ${from} AND p.time_created < ${to}
  `
  const rows = new Map<string, ThinkingRow>()
  const glmTexts: { id: string; bucket: string; modelId: string; text: string }[] = []
  const rowOf = (bucket: string, modelId: string): ThinkingRow => {
    const key = `${bucket}\u0000${modelId}`
    let row = rows.get(key)
    if (!row) {
      row = { bucket, modelId, parts: 0, thinkMs: 0, chars: 0, countedTokens: 0, reportedTokens: 0 }
      rows.set(key, row)
    }
    return row
  }
  {
    const stmt = db.prepare(scanSql)
    try {
      let found = 0
      while (stmt.step()) {
        const r = stmt.get([]) as unknown[]
        const id = toStrOrNull(r[0])
        const timeCreated = toNumOrNull(r[1])
        const modelId = toStrOrNull(r[5])
        if (!id || !timeCreated || !modelId) continue
        found += 1
        if (found % 2000 === 0) {
          post({ id: reqId, ok: true, progress: { phase: 'scan', found } })
        }
        const tStart = toNumOrNull(r[2])
        const tEnd = toNumOrNull(r[3])
        const glmText = toStrOrNull(r[4])
        const row = rowOf(hourBucketKey(timeCreated), modelId)
        row.parts += 1
        if (tStart != null && tEnd != null && tEnd > tStart) row.thinkMs += tEnd - tStart
        if (glmText != null && glmText.length > 0) {
          row.chars += glmText.length
          glmTexts.push({ id, bucket: row.bucket, modelId, text: glmText })
        }
      }
    } finally {
      try {
        stmt.finalize()
      } catch {
        /* already finalized */
      }
    }
  }

  // ② model_usage 的报数真值：本地小时桶 × model 的 reasoning_tokens 之和
  const reportSql = `
    SELECT ${trendBucketExpr('hour')} AS bucket,
           model_id AS modelId,
           SUM(reasoning_tokens) AS rt
    FROM model_usage
    WHERE status='completed' AND started_at >= ${from} AND started_at < ${to}
    GROUP BY bucket, modelId
  `
  {
    const stmt = db.prepare(reportSql)
    try {
      while (stmt.step()) {
        const r = stmt.get([]) as unknown[]
        const bucket = toStrOrNull(r[0])
        const modelId = toStrOrNull(r[1])
        const rt = toNum(r[2])
        if (!bucket || !modelId || rt === 0) continue
        rowOf(bucket, modelId).reportedTokens += rt
      }
    } finally {
      try {
        stmt.finalize()
      } catch {
        /* already finalized */
      }
    }
  }

  // 里程碑：聚合快照先行下发（countedTokens 此时尚为 0），页面立即按估算渲染，
  // 不必等 GLM 计数完成。postMessage 在此瞬间做结构化克隆，之后的原地累加不影响快照。
  post({ id: reqId, ok: true, progress: { phase: 'aggregates', rows: [...rows.values()] } })

  // ③ GLM 原文分批精确计数（tokenCache 命中的直接复用）；中止时保留已完成部分
  let exact = true
  if (glmTexts.length > 0) {
    post({ id: reqId, ok: true, progress: { phase: 'tokenizer' } })
    const tokenizer = await getTokenizer()
    const todo = glmTexts.filter((t) => !tokenCache.has(t.id))
    let counted = glmTexts.length - todo.length
    post({ id: reqId, ok: true, progress: { phase: 'count', counted, total: glmTexts.length } })
    for (let i = 0; i < todo.length; i += THINK_BATCH_SIZE) {
      if (thinkingAbortIds.has(reqId)) {
        exact = false
        break
      }
      for (const t of todo.slice(i, i + THINK_BATCH_SIZE)) {
        tokenCache.set(t.id, tokenizer.count(t.text))
        counted += 1
      }
      post({ id: reqId, ok: true, progress: { phase: 'count', counted, total: glmTexts.length } })
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    for (const t of glmTexts) {
      const n = tokenCache.get(t.id)
      if (n != null) rowOf(t.bucket, t.modelId).countedTokens += n
    }
  }

  const out = [...rows.values()].sort((a, b) =>
    a.bucket === b.bucket ? (a.modelId < b.modelId ? -1 : 1) : a.bucket < b.bucket ? -1 : 1,
  )
  return { rows: out, exact }
}

// Serialize main() init and per-request handlers. The main thread may
// post the first message before main()'s await resolves.
let readyPromise: Promise<void> | null = null

function post(msg: WorkerOutput) {
  ;(self as unknown as Worker).postMessage(msg)
}

async function main() {
  sqlite3 = await sqlite3InitModule({
    print: console.log,
    printErr: console.error,
    locateFile: (path: string) => {
      if (path === 'sqlite3.wasm') return sqlite3WasmUrl
      return path
    },
  })

  const capi = sqlite3.capi
  const wasm = sqlite3.wasm

  const ioStruct = new capi.sqlite3_io_methods()
  const vfsStruct = new capi.sqlite3_vfs()
  // Must be set BEFORE installVfs/registerVfs: a zeroed struct breaks open.
  ioStruct.$iVersion = 1
  vfsStruct.$iVersion = 2
  vfsStruct.$szOsFile = capi.sqlite3_file.structInfo.sizeof
  vfsStruct.$mxPathname = 512
  ioMethodsPtr = ioStruct.pointer

  const ioMethods = {
    xClose() {
      return SQLITE_OK
    },
    // xRead(file, zBuf, iAmt, iOfst): read iAmt bytes at iOfst into the
    // wasm heap at zBuf. Short reads must zero-fill the remainder.
    xRead(_file: number, zBuf: number, iAmt: number, iOfst: number) {
      if (!openFileHandle) return SQLITE_IOERR_READ
      try {
        const offset = Number(iOfst)
        const amount = Number(iAmt)
        const heap = wasm.heap8u()
        heap.fill(0, zBuf, zBuf + amount)
        if (offset >= openFileSize) return SQLITE_OK
        const end = Math.min(offset + amount, openFileSize)
        const blob = openFileHandle.slice(offset, end)
        const bytes = new Uint8Array(getReader().readAsArrayBuffer(blob))
        if (bytes.byteLength !== end - offset) return SQLITE_IOERR_READ
        heap.set(bytes, zBuf)
        return SQLITE_OK
      } catch (err) {
        console.error('xRead error', err)
        return SQLITE_IOERR_READ
      }
    },
    xWrite() {
      return SQLITE_READONLY
    },
    xTruncate() {
      return SQLITE_READONLY
    },
    xSync() {
      return SQLITE_OK
    },
    // xFileSize(file, pSize): write int64 to *pSize.
    xFileSize(_file: number, pSize: number) {
      wasm.poke(pSize, BigInt(openFileSize), 'i64')
      return SQLITE_OK
    },
    xLock() {
      return SQLITE_OK
    },
    xUnlock() {
      return SQLITE_OK
    },
    // xCheckReservedLock(file, pResOut): write int32 0/1.
    xCheckReservedLock(_file: number, pResOut: number) {
      wasm.poke(pResOut, 0, 'i32')
      return SQLITE_OK
    },
    // xFileControl: we handle no opcodes; SQLITE_NOTFOUND (=12) is the
    // contract-mandated "not handled" response. Missing slot = null-function
    // trap during open (SQLite queries PERSIST_WAL right after page 1 read).
    xFileControl() {
      return 12
    },
    xSectorSize() {
      return 4096
    },
    xDeviceCharacteristics() {
      return 0
    },
    xShmMap() {
      return SQLITE_READONLY
    },
    xShmLock() {
      return SQLITE_READONLY
    },
    xShmBarrier() {},
    xShmUnmap() {
      return SQLITE_OK
    },
    xFetch() {
      return SQLITE_READONLY
    },
    xUnfetch() {
      return SQLITE_OK
    },
  }

  const vfsMethods = {
    // xOpen(vfs, zName, pFile, flags, pOutFlags)
    xOpen(_vfsPtr: number, _zName: number, pFile: number, flags: number, pOutFlags: number) {
      const writable = (flags & 0x02) !== 0 // SQLITE_OPEN_READWRITE
      const create = (flags & 0x04) !== 0 // SQLITE_OPEN_CREATE
      if (writable || create) return SQLITE_READONLY
      // Wire the io methods into sqlite3_file (pMethods is its only
      // member, at offset 0) and report the actual open flags.
      wasm.pokePtr(pFile, ioMethodsPtr)
      wasm.poke(pOutFlags, SQLITE_OPEN_READONLY, 'i32')
      return SQLITE_OK
    },
    // Deleting absent journal/WAL files must succeed (no-op).
    xDelete() {
      return SQLITE_OK
    },
    // xAccess(vfs, zName, flags, pResOut): write int32 0/1 to *pResOut.
    xAccess(_vfsPtr: number, zName: number, _flags: number, pResOut: number) {
      const name = wasm.cstrToJs(zName) ?? ''
      const exists = name === openFileName
      wasm.poke(pResOut, exists ? 1 : 0, 'i32')
      return SQLITE_OK
    },
    // xFullPathname(vfs, zName, nOut, zOut): copy name + NUL.
    xFullPathname(_vfsPtr: number, zName: number, nOut: number, zOut: number) {
      const name = wasm.cstrToJs(zName) ?? ''
      const bytes = new TextEncoder().encode(name + '\0')
      if (bytes.byteLength > nOut) return SQLITE_READONLY
      wasm.heap8u().set(bytes, zOut)
      return SQLITE_OK
    },
    xDlOpen() {
      return 0
    },
    xDlError() {},
    xDlSym() {
      return 0
    },
    xDlClose() {},
    xRandomness(_v: number, nByte: number, zOut: number) {
      const heap = wasm.heap8u()
      for (let i = 0; i < nByte; i += 1) {
        heap[zOut + i] = Math.floor(Math.random() * 256)
      }
      return SQLITE_OK
    },
    xSleep(_v: number, microseconds: number) {
      const end = performance.now() + microseconds / 1000
      while (performance.now() < end) {
        /* spin */
      }
      return SQLITE_OK
    },
    // xCurrentTime(vfs, pTimeOut): *pTimeOut is a float64 (Julian days).
    xCurrentTime(_v: number, pTimeOut: number) {
      const julianDays = Date.now() / 86400000 + 2440587.5
      wasm.poke(pTimeOut, julianDays, 'f64')
      return SQLITE_OK
    },
    xGetLastError() {},
    // xCurrentTimeInt64(vfs, pTimeOut): *pTimeOut is int64 microseconds.
    xCurrentTimeInt64(_v: number, pTimeOut: number) {
      const micros = Math.floor((Date.now() / 86400000 + 2440587.5) * 86400000000)
      wasm.poke(pTimeOut, BigInt(micros), 'i64')
      return SQLITE_OK
    },
    xSetSystemCall() {
      return SQLITE_READONLY
    },
    xGetSystemCall() {
      return 0
    },
    xNextSystemCall() {
      return 0
    },
  }

  const traceWrap = (prefix: string, obj: Record<string, (...a: never[]) => unknown>) => {
    if (!DEBUG_VFS_TRACE) return obj
    return Object.fromEntries(
      Object.entries(obj).map(([k, fn]) => [
        k,
        (...args: unknown[]) => {
          post({ id: -1, ok: true, result: { kind: 'trace', name: `${prefix}.${k}`, argc: args.length } })
          return (fn as (...a: unknown[]) => unknown)(...args)
        },
      ]),
    )
  }

  sqlite3.vfs.installVfs({
    io: {
      struct: ioStruct,
      methods: traceWrap('io', ioMethods) as typeof ioMethods,
    },
    vfs: {
      struct: vfsStruct,
      name: 'zcode-stats',
      asDefault: true,
      methods: traceWrap('vfs', vfsMethods) as typeof vfsMethods,
    },
  })
}

// FileReaderSync is worker-only; instantiate lazily.
let readerSync: FileReaderSync | null = null
function getReader(): FileReaderSync {
  if (!readerSync) {
    readerSync = new FileReaderSync()
  }
  return readerSync
}

self.addEventListener('message', async (ev: MessageEvent<WorkerInput>) => {
  const req = ev.data
  if (!req || typeof req.id !== 'number') return
  try {
    // Wait for init: the first message can arrive before main() resolves.
    if (readyPromise) await readyPromise

    if (req.op === 'open') {
      openFileHandle = req.args.file
      openFileName = req.args.filename || 'db.sqlite'
      openFileSize = openFileHandle?.size ?? 0
      // 换了数据库文件：旧文件的 token 计数与中止标记全部作废
      tokenCache.clear()
      thinkingAbortIds.clear()
      activeThinkingId = null
      if (!openFileHandle) {
        throw new Error('open: file handle is null')
      }
      // oo1.DB flags string: 'r' = readonly. IMPORTANT: the option key is
      // `flags` — a `mode` key is ignored and silently defaults to 'c'
      // (create|readwrite), which our read-only VFS rejects.
      //
      // immutable=1: the File snapshot cannot change under us, so tell
      // SQLite to skip locking, WAL recovery and shm handling entirely —
      // read-only WAL-mode databases otherwise fail to open (CANTOPEN).
      db = new sqlite3.oo1.DB(`file:${openFileName}?immutable=1`, 'r', 'zcode-stats')
      // Our xOpen rejects CREATE, so force all temp structures into memory:
      // big GROUP BY / ORDER BY would otherwise try to open temp files.
      // Non-fatal: if the pragma itself fails, selects still work.
      try {
        db.exec('PRAGMA temp_store=MEMORY; PRAGMA cache_size=-32768;')
      } catch (err) {
        console.error('pragma failed (non-fatal)', err)
      }
      post({ id: req.id, ok: true, result: { size: openFileSize } })
      return
    }
    if (req.op === 'close') {
      if (db) {
        try {
          db.close()
        } catch (err) {
          console.error('db.close failed', err)
        }
        db = null
      }
      openFileHandle = null
      post({ id: req.id, ok: true, result: null })
      return
    }
    if (req.op === 'thinking') {
      if (!db) throw new Error('thinking: db not open')
      // 只保留最新任务：旧任务在批次边界自动停止（其结果仍会返回，调用方已不关心）
      if (activeThinkingId != null) thinkingAbortIds.add(activeThinkingId)
      activeThinkingId = req.id
      const result = await runThinking(req.id, req.args.from, req.args.to)
      if (activeThinkingId === req.id) activeThinkingId = null
      thinkingAbortIds.delete(req.id)
      post({ id: req.id, ok: true, result })
      return
    }
    if (req.op === 'thinkingAbort') {
      thinkingAbortIds.add(req.args.targetId)
      post({ id: req.id, ok: true, result: null })
      return
    }
    if (req.op === 'select') {
      if (!db) throw new Error('select: db not open')
      const { sql, bind = [] } = req.args
      const rows: unknown[][] = []
      const columns: string[] = []
      const stmt = db.prepare(sql)
      try {
        if (bind.length > 0) stmt.bind(bind)
        while (stmt.step()) {
          // get([]) returns the current row as a plain value array.
          rows.push(stmt.get([]) as unknown[])
          if (columns.length === 0) {
            columns.push(...stmt.getColumnNames())
          }
        }
      } finally {
        try {
          stmt.finalize()
        } catch {
          /* already finalized */
        }
      }
      post({ id: req.id, ok: true, result: { columns, rows } })
      return
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? (err.stack ?? '') : ''
    post({ id: req.id, ok: false, error: stack ? `${msg}\n${stack}` : msg })
  }
})

readyPromise = main()
  .then(() => undefined)
  .catch((err) => {
    post({ id: 0, ok: false, error: `worker init failed: ${err?.message ?? err}` })
  })
