import { useState } from 'react'
import { useApiGet, apiPost, ApiError } from '../lib/api'
import type { ActionsResponse, ActionStatus, RunInfo, StartRunResponse } from '../lib/types'
import { Panel, Pill } from '../components/ui'
import { useSession } from '../lib/session'

/** Fixed endpoint per action kind — mirrors the backend registry (PRD §5.2). */
const START_REQUEST: Record<string, { path: string; body?: unknown }> = {
  'inbox-classify': { path: '/api/run/inbox-classify' },
  'nightly-consolidation': { path: '/api/run/nightly-consolidation' },
  'weekly-digest': { path: '/api/run/weekly-digest' },
  'ghl-sync-colma': { path: '/api/run/ghl-sync', body: { business: 'colma' } },
  'ghl-sync-upd-urns': { path: '/api/run/ghl-sync', body: { business: 'upd-urns' } },
  'auth-probe': { path: '/api/run/auth-probe' },
}

/** Actions that let Claude write inside the vault get a two-step confirm. */
const WRITE_GROUP = 'vault-write'

function ActionRow({
  action,
  onStarted,
  onError,
}: {
  action: ActionStatus
  onStarted: (run: RunInfo) => void
  onError: (message: string) => void
}) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const { canWrite } = useSession()

  const needsConfirm = action.group === WRITE_GROUP

  async function trigger(): Promise<void> {
    if (needsConfirm && !armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    setBusy(true)
    try {
      const req = START_REQUEST[action.kind]
      if (!req) throw new Error(`No endpoint mapped for ${action.kind}`)
      const res = await apiPost<StartRunResponse>(req.path, req.body)
      onStarted(res.run)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'RUN_IN_PROGRESS') {
        onError('Another vault run is in progress — wait for it or cancel it first.')
      } else {
        onError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-1.5 border-b border-neutral-800/60 py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-xs text-neutral-200">{action.title}</span>
        <div className="flex items-center gap-2">
          {action.configured ? (
            <Pill tone={action.group === WRITE_GROUP ? 'amber' : 'green'} label={action.group === WRITE_GROUP ? 'Writes vault' : 'Read-only'} />
          ) : (
            <Pill tone="neutral" label="Not configured" />
          )}
          <button
            type="button"
            disabled={!action.configured || busy || !canWrite}
            onClick={() => void trigger()}
            className={`rounded border px-3 py-1 font-mono text-[10px] tracking-widest uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
              armed
                ? 'border-amber-500/60 bg-amber-500/10 text-amber-300'
                : 'border-copper-500/40 text-copper-300 hover:bg-copper-500/10'
            }`}
          >
            {armed ? 'Confirm run' : 'Run'}
          </button>
        </div>
      </div>
      <p className="text-[11px] leading-relaxed text-neutral-500">{action.description}</p>
      {armed && (
        <p className="font-mono text-[10px] text-amber-400">
          This lets Claude create/edit notes in the vault (per its CLAUDE.md rules). Click again to
          confirm, or select another action to abort.
        </p>
      )}
      {!action.configured && action.missing.length > 0 && (
        <ul className="font-mono text-[10px] leading-relaxed text-neutral-600">
          {action.missing.map((m) => (
            <li key={m}>· missing: {m}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function ActionsPanel({ onRunStarted }: { onRunStarted: (run: RunInfo) => void }) {
  const catalog = useApiGet<ActionsResponse>('/api/actions', 30_000)
  const [error, setError] = useState<string | null>(null)

  const pill =
    catalog.status === 'loading'
      ? ({ tone: 'amber', label: 'Loading' } as const)
      : catalog.status === 'error'
        ? ({ tone: 'red', label: 'Error' } as const)
        : ({ tone: 'green', label: 'Ready' } as const)

  return (
    <Panel title="Actions" pill={pill}>
      {catalog.status === 'loading' && (
        <p className="font-mono text-xs text-neutral-500">Loading action catalog…</p>
      )}
      {catalog.status === 'error' && <p className="font-mono text-xs text-red-400">{catalog.message}</p>}
      {catalog.status === 'success' && (
        <div>
          {error && <p className="mb-2 font-mono text-xs text-red-400">{error}</p>}
          {catalog.data.actions.map((action) => (
            <ActionRow
              key={action.kind}
              action={action}
              onStarted={(run) => {
                setError(null)
                onRunStarted(run)
              }}
              onError={setError}
            />
          ))}
        </div>
      )}
    </Panel>
  )
}
