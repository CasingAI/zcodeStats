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
  | { id: number; op: 'close' }

type WorkerOutput =
  | { id: number; ok: true; result: unknown }
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
