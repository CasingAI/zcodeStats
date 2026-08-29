// Lightweight data-fetching hook for the worker RPC.

import { useEffect, useState } from 'preact/hooks'
import type { OpenedDb } from '../db/client.ts'

export type QueryState<T> =
  | { kind: 'loading' }
  | { kind: 'ok'; data: T }
  | { kind: 'error'; error: string }

export function useQuery<T>(
  db: OpenedDb | null,
  /** A stable key. When it changes, the query re-runs. */
  key: string,
  /** The query to run when the key is current. */
  fetcher: (db: OpenedDb) => Promise<T>,
): QueryState<T> {
  const [state, setState] = useState<QueryState<T>>({ kind: 'loading' })
  useEffect(() => {
    if (!db) {
      setState({ kind: 'loading' })
      return
    }
    let cancelled = false
    setState({ kind: 'loading' })
    fetcher(db)
      .then((data) => {
        if (cancelled) return
        setState({ kind: 'ok', data })
      })
      .catch((err) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        setState({ kind: 'error', error: msg })
      })
    return () => {
      cancelled = true
    }
    // fetcher should be stable (closed over `db` only); key drives re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, key])
  return state
}
