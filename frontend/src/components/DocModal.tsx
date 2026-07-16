import { useEffect, useState } from 'react'
import { apiGet, apiPost, ApiError } from '../lib/api'
import type { KnowledgeSourceId, KnowledgeDocMeta, KnowledgeDocContent } from '../lib/types'
import { Markdown } from '../lib/markdown'
import { lineDiff, diffStats } from '../lib/diff'

export function vaultNameFromPath(p: unknown): string {
  return typeof p === 'string' ? (p.split('/').filter(Boolean).pop() ?? 'MyBrain') : 'MyBrain'
}

interface RegenPreview {
  id: string
  path: string
  current: string
  proposed: string
  generatedBy: string
}

type RegenState =
  | { phase: 'idle' }
  | { phase: 'previewing' }
  | { phase: 'error'; message: string }
  | { phase: 'diff'; data: RegenPreview }
  | { phase: 'applying'; data: RegenPreview }
  | { phase: 'applied'; message: string }

function DiffView({ current, proposed }: { current: string; proposed: string }) {
  const lines = lineDiff(current, proposed)
  const { added, removed } = diffStats(lines)
  return (
    <div>
      <p className="mb-2 font-mono text-[11px] tracking-wider text-neutral-500 uppercase">
        Proposed diff · <span className="text-emerald-400">+{added}</span>{' '}
        <span className="text-red-400">−{removed}</span>
      </p>
      <pre className="max-h-[46vh] overflow-auto rounded-md border border-neutral-800 bg-neutral-950/80 p-3 font-mono text-[11px] leading-relaxed">
        {lines.map((l, i) => (
          <div
            key={i}
            className={
              l.type === 'add'
                ? 'bg-emerald-500/10 text-emerald-300'
                : l.type === 'del'
                  ? 'bg-red-500/10 text-red-300'
                  : 'text-neutral-500'
            }
          >
            <span className="select-none text-neutral-700">{l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : '  '}</span>
            {l.text || ' '}
          </div>
        ))}
      </pre>
    </div>
  )
}

/** Modal that fetches and renders one knowledge document, with vault Regenerate (Pattern B). */
export function DocModal({
  source,
  doc,
  vaultName,
  onClose,
}: {
  source: KnowledgeSourceId
  doc: KnowledgeDocMeta
  vaultName: string
  onClose: () => void
}) {
  const [state, setState] = useState<
    { status: 'loading' | 'error'; message?: string } | { status: 'ok'; data: KnowledgeDocContent }
  >({ status: 'loading' })
  const [regen, setRegen] = useState<RegenState>({ phase: 'idle' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    apiGet<{ doc: KnowledgeDocContent }>(`/api/knowledge/doc?source=${source}&id=${encodeURIComponent(doc.id)}`)
      .then((r) => !cancelled && setState({ status: 'ok', data: r.doc }))
      .catch((e) => !cancelled && setState({ status: 'error', message: e instanceof Error ? e.message : String(e) }))
    return () => {
      cancelled = true
    }
  }, [source, doc.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const obsidianUri =
    source === 'vault'
      ? `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(doc.path.replace(/\.md$/i, ''))}`
      : null
  const canRegenerate = source === 'vault'

  async function startPreview(): Promise<void> {
    setRegen({ phase: 'previewing' })
    try {
      const r = await apiPost<{ preview: RegenPreview }>('/api/regenerate/preview', { id: doc.id })
      setRegen({ phase: 'diff', data: r.preview })
    } catch (e) {
      const msg =
        e instanceof ApiError && e.code === 'CLI_FAILED'
          ? `${e.message} — is the Claude CLI authenticated? (run \`claude auth login\`)`
          : e instanceof Error
            ? e.message
            : String(e)
      setRegen({ phase: 'error', message: msg })
    }
  }

  async function confirmApply(data: RegenPreview): Promise<void> {
    setRegen({ phase: 'applying', data })
    try {
      const r = await apiPost<{ applied: { path: string; bytesWritten: number; backupFile: string } }>(
        '/api/regenerate/apply',
        { id: doc.id, approvedContent: data.proposed },
      )
      setRegen({
        phase: 'applied',
        message: `Overwrote ${r.applied.path} (${r.applied.bytesWritten} bytes). Backup saved. Review/commit in your vault git.`,
      })
      // refresh the rendered document with the new content
      setState((s) => (s.status === 'ok' ? { status: 'ok', data: { ...s.data, content: data.proposed } } : s))
    } catch (e) {
      setRegen({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  const inRegen = regen.phase !== 'idle'

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/75 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-neutral-800 p-4">
          <div className="min-w-0">
            <h3 className="truncate font-mono text-sm font-bold text-neutral-100">{doc.name}</h3>
            <p className="mt-0.5 truncate font-mono text-[10px] text-neutral-500">
              {source === 'drive' ? 'Drive · obsidianbus' : 'Vault · MyBrain'} · {doc.path}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {canRegenerate && !inRegen && (
              <button
                type="button"
                onClick={() => void startPreview()}
                className="rounded border border-copper-500/40 px-2 py-1 font-mono text-[10px] tracking-wider text-copper-300 uppercase hover:bg-copper-500/10"
              >
                Regenerate
              </button>
            )}
            {obsidianUri && (
              <a
                href={obsidianUri}
                className="rounded border border-neutral-700 px-2 py-1 font-mono text-[10px] tracking-wider text-neutral-300 uppercase hover:bg-neutral-800"
              >
                Open in Obsidian
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-neutral-700 px-2 py-1 font-mono text-[10px] tracking-wider text-neutral-400 uppercase hover:bg-neutral-800"
            >
              Close
            </button>
          </div>
        </header>

        <div className="max-h-[70vh] overflow-y-auto p-5">
          {/* Regenerate flow overrides the document body while active */}
          {regen.phase === 'previewing' && (
            <p className="font-mono text-xs text-neutral-500">
              Generating proposal via <span className="text-copper-300">claude -p</span> (read-only)… nothing is written yet.
            </p>
          )}
          {regen.phase === 'error' && (
            <div className="space-y-2">
              <p className="font-mono text-xs text-red-400">{regen.message}</p>
              <button
                type="button"
                onClick={() => setRegen({ phase: 'idle' })}
                className="rounded border border-neutral-700 px-2 py-1 font-mono text-[10px] tracking-wider text-neutral-400 uppercase hover:bg-neutral-800"
              >
                Back
              </button>
            </div>
          )}
          {(regen.phase === 'diff' || regen.phase === 'applying') && (
            <div className="space-y-3">
              <p className="font-mono text-[10px] text-neutral-600">
                Proposal by {regen.data.generatedBy}. Review before overwriting — nothing has been written yet.
              </p>
              <DiffView current={regen.data.current} proposed={regen.data.proposed} />
              <div className="flex flex-wrap items-center gap-2 border-t border-neutral-800 pt-3">
                <p className="grow font-mono text-[10px] text-amber-400">
                  ⚠ Confirm overwrites {regen.data.path} in the vault. A backup is kept; changes land in your vault git for review.
                </p>
                <button
                  type="button"
                  disabled={regen.phase === 'applying'}
                  onClick={() => setRegen({ phase: 'idle' })}
                  className="rounded border border-neutral-700 px-3 py-1 font-mono text-[10px] tracking-wider text-neutral-400 uppercase hover:bg-neutral-800 disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={regen.phase === 'applying'}
                  onClick={() => void confirmApply(regen.data)}
                  className="rounded border border-amber-500/60 bg-amber-500/10 px-3 py-1 font-mono text-[10px] tracking-wider text-amber-300 uppercase hover:bg-amber-500/20 disabled:opacity-40"
                >
                  {regen.phase === 'applying' ? 'Writing…' : 'Confirm overwrite'}
                </button>
              </div>
            </div>
          )}
          {regen.phase === 'applied' && (
            <div className="space-y-2">
              <p className="font-mono text-xs text-emerald-400">✓ {regen.message}</p>
              <button
                type="button"
                onClick={() => setRegen({ phase: 'idle' })}
                className="rounded border border-neutral-700 px-2 py-1 font-mono text-[10px] tracking-wider text-neutral-400 uppercase hover:bg-neutral-800"
              >
                Back to document
              </button>
            </div>
          )}

          {/* Document body (shown when not in a regen sub-flow) */}
          {regen.phase === 'idle' && (
            <>
              {state.status === 'loading' && <p className="font-mono text-xs text-neutral-500">Loading document…</p>}
              {state.status === 'error' && <p className="font-mono text-xs text-red-400">{state.message}</p>}
              {state.status === 'ok' && state.data.content !== null && <Markdown text={state.data.content} />}
              {state.status === 'ok' && state.data.content === null && (
                <div className="space-y-2">
                  <p className="text-[13px] text-neutral-300">{doc.summary}</p>
                  <p className="font-mono text-[11px] text-amber-400">
                    {state.data.message ?? 'Content not extracted in this snapshot.'}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
