import { useEffect, useState } from 'react'
import type { RunInfo, RunLogLine } from './types'

/** Client-side memory bound for streamed lines. */
const MAX_CLIENT_LINES = 2_000

export interface RunStream {
  run: RunInfo | null
  lines: RunLogLine[]
  streamError: boolean
}

/**
 * Follows one run over SSE. The server replays the retained (redacted) log,
 * then pushes live lines; on the `end` event the EventSource is closed so it
 * does not reconnect in a loop. Cleanup closes the connection on unmount or
 * run change.
 */
export function useRunStream(runId: string | null): RunStream {
  const [run, setRun] = useState<RunInfo | null>(null)
  const [lines, setLines] = useState<RunLogLine[]>([])
  const [streamError, setStreamError] = useState(false)

  useEffect(() => {
    setRun(null)
    setLines([])
    setStreamError(false)
    if (runId === null) return

    const source = new EventSource(`/api/runs/${runId}/stream`)

    source.addEventListener('line', (event) => {
      const line = JSON.parse((event as MessageEvent<string>).data) as RunLogLine
      setLines((prev) => {
        const next = [...prev, line]
        return next.length > MAX_CLIENT_LINES ? next.slice(-MAX_CLIENT_LINES) : next
      })
    })
    source.addEventListener('status', (event) => {
      setRun(JSON.parse((event as MessageEvent<string>).data) as RunInfo)
    })
    source.addEventListener('end', (event) => {
      setRun(JSON.parse((event as MessageEvent<string>).data) as RunInfo)
      source.close()
    })
    source.onerror = () => {
      // Auto-reconnect handles transient drops; a closed source is permanent.
      if (source.readyState === EventSource.CLOSED) setStreamError(true)
    }

    return () => source.close()
  }, [runId])

  return { run, lines, streamError }
}
