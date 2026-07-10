import { useApiGet } from '../lib/api'
import type { LastLogResponse } from '../lib/types'
import { Panel } from '../components/ui'
import type { PillTone } from '../components/ui'

/** Tail of the vault's .claude/nightly.log — the cron consolidation output. */
export function NightlyLogPanel() {
  const log = useApiGet<LastLogResponse>('/api/last-log?lines=40', 60_000)

  let pill: { tone: PillTone; label: string }
  if (log.status === 'loading') pill = { tone: 'amber', label: 'Reading' }
  else if (log.status === 'error') pill = { tone: 'red', label: 'Error' }
  else if (!log.data.available) pill = { tone: 'neutral', label: 'No data found' }
  else pill = { tone: 'green', label: 'Available' }

  return (
    <Panel title="Nightly log" pill={pill}>
      {log.status === 'loading' && (
        <p className="font-mono text-xs text-neutral-500">Reading .claude/nightly.log…</p>
      )}

      {log.status === 'error' && <p className="font-mono text-xs text-red-400">{log.message}</p>}

      {log.status === 'success' && !log.data.available && (
        <p className="text-xs leading-relaxed text-neutral-500">
          {log.data.message ?? 'No log data found.'}
        </p>
      )}

      {log.status === 'success' && log.data.available && (
        <div className="space-y-2">
          <p className="font-mono text-[10px] tracking-wider text-neutral-600 uppercase">
            {log.data.path} · {log.data.sizeBytes} bytes
            {log.data.truncated ? ' · tail' : ''}
          </p>
          <pre className="max-h-56 overflow-auto rounded-md border border-neutral-800 bg-neutral-950/80 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-neutral-300">
            {(log.data.lines ?? []).join('\n') || '(empty file)'}
          </pre>
        </div>
      )}
    </Panel>
  )
}
