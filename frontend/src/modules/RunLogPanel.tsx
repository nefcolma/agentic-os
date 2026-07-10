import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, apiPost, ApiError } from '../lib/api'
import type { RunInfo, RunsListResponse, RunStatus, StartRunResponse } from '../lib/types'
import { useRunStream } from '../lib/useRunStream'
import { Panel, Pill } from '../components/ui'
import type { PillTone } from '../components/ui'

const STATUS_TONE: Record<RunStatus, PillTone> = {
  queued: 'neutral',
  running: 'amber',
  succeeded: 'green',
  failed: 'red',
  cancelled: 'copper',
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

const STREAM_COLOR: Record<string, string> = {
  stdout: 'text-neutral-300',
  stderr: 'text-amber-300',
  system: 'text-copper-400',
}

export function RunLogPanel({
  selectedRunId,
  onSelectRun,
}: {
  selectedRunId: string | null
  onSelectRun: (id: string | null) => void
}) {
  const [runs, setRuns] = useState<RunInfo[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)

  const { run: streamedRun, lines } = useRunStream(selectedRunId)

  const refreshRuns = useCallback(async (): Promise<void> => {
    try {
      const res = await apiGet<RunsListResponse>('/api/runs')
      setRuns(res.runs)
      setListError(null)
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refreshRuns()
    const id = setInterval(() => void refreshRuns(), 10_000)
    return () => clearInterval(id)
  }, [refreshRuns])

  // Keep the list in sync when the streamed run changes state.
  useEffect(() => {
    if (streamedRun) {
      setRuns((prev) =>
        prev ? prev.map((r) => (r.id === streamedRun.id ? streamedRun : r)) : prev,
      )
    }
  }, [streamedRun])

  // Follow the log tail as new lines arrive.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  async function startSelfTest(): Promise<void> {
    setStarting(true)
    setActionError(null)
    try {
      const res = await apiPost<StartRunResponse>('/api/run/self-test')
      onSelectRun(res.run.id)
      await refreshRuns()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'RUN_IN_PROGRESS') {
        setActionError('A self-test is already running — wait for it or cancel it.')
      } else {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setStarting(false)
    }
  }

  async function cancelRun(id: string): Promise<void> {
    setActionError(null)
    try {
      await apiPost<{ run: RunInfo }>(`/api/runs/${id}/cancel`)
      await refreshRuns()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  const selectedRun = streamedRun ?? runs?.find((r) => r.id === selectedRunId) ?? null
  const latest = runs?.[0]
  const headerPill: { tone: PillTone; label: string } = latest
    ? { tone: STATUS_TONE[latest.status], label: latest.status }
    : { tone: 'neutral', label: 'Idle' }

  return (
    <Panel title="Run log" pill={headerPill}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void startSelfTest()}
            disabled={starting}
            className="rounded border border-copper-500/40 px-3 py-1.5 font-mono text-[11px] tracking-widest text-copper-300 uppercase transition-colors hover:bg-copper-500/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Run self-test
          </button>
          <span className="font-mono text-[10px] text-neutral-600">
            Fixed harmless diagnostic — spawns node, never touches the vault
          </span>
        </div>

        {actionError && <p className="font-mono text-xs text-red-400">{actionError}</p>}
        {listError && <p className="font-mono text-xs text-red-400">{listError}</p>}

        {runs !== null && runs.length === 0 && (
          <p className="font-mono text-xs text-neutral-600">No runs yet.</p>
        )}

        {runs !== null && runs.length > 0 && (
          <ul className="max-h-40 overflow-auto rounded-md border border-neutral-800">
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => onSelectRun(run.id)}
                  className={`flex w-full items-center justify-between gap-2 border-b border-neutral-800/60 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-neutral-800/40 ${
                    run.id === selectedRunId ? 'bg-neutral-800/60' : ''
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-xs text-neutral-200">{run.kind}</span>
                    <span className="block font-mono text-[10px] text-neutral-600">
                      {new Date(run.createdAt).toLocaleTimeString()} · {formatDuration(run.durationMs)}
                    </span>
                  </span>
                  <Pill tone={STATUS_TONE[run.status]} label={run.status} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {selectedRun && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[10px] tracking-wider text-neutral-500 uppercase">
                {selectedRun.title} · {selectedRun.logBytes} bytes
                {selectedRun.logTruncatedHead ? ' · head truncated' : ''}
              </span>
              {(selectedRun.status === 'running' || selectedRun.status === 'queued') && (
                <button
                  type="button"
                  onClick={() => void cancelRun(selectedRun.id)}
                  className="rounded border border-red-500/40 px-2 py-1 font-mono text-[10px] tracking-widest text-red-400 uppercase transition-colors hover:bg-red-500/10"
                >
                  Cancel
                </button>
              )}
            </div>
            {selectedRun.error && (
              <p className="font-mono text-xs text-red-400">{selectedRun.error}</p>
            )}
            <pre
              ref={logRef}
              className="max-h-64 overflow-auto rounded-md border border-neutral-800 bg-neutral-950/80 p-3 font-mono text-[11px] leading-relaxed"
            >
              {lines.length === 0 ? (
                <span className="text-neutral-600">(no output yet)</span>
              ) : (
                lines.map((line) => (
                  <span key={line.seq} className={`block ${STREAM_COLOR[line.stream] ?? 'text-neutral-300'}`}>
                    {line.text}
                  </span>
                ))
              )}
            </pre>
          </div>
        )}
      </div>
    </Panel>
  )
}
