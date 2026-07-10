import { useApiGet } from '../lib/api'
import type { VaultSummary, FolderSummary, NoteSummary } from '../lib/types'
import { Panel, Pill, statusTone } from '../components/ui'
import type { PillTone } from '../components/ui'

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-950/60 px-4 py-3">
      <div className="font-mono text-2xl font-bold text-neutral-100">{value}</div>
      <div className="mt-1 font-mono text-[10px] tracking-[0.2em] text-neutral-500 uppercase">{label}</div>
    </div>
  )
}

function NoteRow({ note }: { note: NoteSummary }) {
  return (
    <li className="flex items-center justify-between gap-2 border-b border-neutral-800/60 py-1.5 last:border-b-0">
      <div className="min-w-0">
        <p className="truncate text-xs text-neutral-200" title={note.file}>
          {note.title}
        </p>
        <p className="font-mono text-[10px] text-neutral-600">
          {note.created ?? note.modifiedAt.slice(0, 10)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!note.frontmatterOk && <Pill tone="amber" label="No FM" />}
        {note.status && <Pill tone={statusTone(note.status)} label={note.status} />}
      </div>
    </li>
  )
}

function FolderColumn({ heading, folder }: { heading: string; folder: FolderSummary }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-1 font-mono text-[10px] tracking-[0.2em] text-neutral-500 uppercase">
        {heading} <span className="text-neutral-600">· {folder.folder}</span>
      </h3>
      {!folder.exists && <p className="font-mono text-[11px] text-red-400">Folder missing</p>}
      {folder.exists && folder.count === 0 && (
        <p className="font-mono text-[11px] text-neutral-600">Empty</p>
      )}
      <ul>
        {folder.notes.map((note) => (
          <NoteRow key={note.file} note={note} />
        ))}
      </ul>
    </div>
  )
}

export function VaultPanel() {
  const summary = useApiGet<VaultSummary>('/api/vault-summary', 30_000)

  let pill: { tone: PillTone; label: string }
  if (summary.status === 'loading') pill = { tone: 'amber', label: 'Reading' }
  else if (summary.status === 'error')
    pill =
      summary.code === 'VAULT_NOT_FOUND'
        ? { tone: 'neutral', label: 'Unavailable' }
        : { tone: 'red', label: 'Error' }
  else pill = { tone: 'green', label: 'Live' }

  return (
    <Panel title="Vault — MyBrain" pill={pill}>
      {summary.status === 'loading' && (
        <p className="font-mono text-xs text-neutral-500">Reading vault frontmatter…</p>
      )}

      {summary.status === 'error' && (
        <p className="font-mono text-xs text-red-400">{summary.message}</p>
      )}

      {summary.status === 'success' && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <Metric label="Projects" value={summary.data.folders.projects.count} />
            <Metric label="Areas" value={summary.data.folders.areas.count} />
            <Metric label="Inbox" value={summary.data.folders.inbox.count} />
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <FolderColumn heading="Open projects" folder={summary.data.folders.projects} />
            <FolderColumn heading="Active areas" folder={summary.data.folders.areas} />
            <FolderColumn heading="Inbox items" folder={summary.data.folders.inbox} />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-800 pt-3">
            <span className="font-mono text-[11px] tracking-wider text-neutral-500 uppercase">
              Last nightly consolidation
            </span>
            {summary.data.lastConsolidation.available &&
            summary.data.lastConsolidation.modifiedAt ? (
              <span className="flex items-center gap-2">
                <span className="font-mono text-xs text-neutral-200">
                  {new Date(summary.data.lastConsolidation.modifiedAt).toLocaleString()}
                </span>
                <Pill tone="green" label="Logged" />
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <span className="font-mono text-xs text-neutral-500">
                  {summary.data.lastConsolidation.logPath}
                </span>
                <Pill tone="neutral" label="No data found" />
              </span>
            )}
          </div>
        </div>
      )}
    </Panel>
  )
}
