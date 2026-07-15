import { useEffect, useState } from 'react'
import { useApiGet, apiGet, apiPost } from '../lib/api'
import type {
  KnowledgeSourcesResponse,
  KnowledgeSource,
  KnowledgeSourceId,
  KnowledgeDocMeta,
  KnowledgeDocContent,
} from '../lib/types'
import { Panel, Pill } from '../components/ui'
import { Markdown } from '../lib/markdown'

function vaultNameFromPath(p: unknown): string {
  return typeof p === 'string' ? (p.split('/').filter(Boolean).pop() ?? 'MyBrain') : 'MyBrain'
}

function DocModal({
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
  const [state, setState] = useState<{ status: 'loading' | 'error'; message?: string } | { status: 'ok'; data: KnowledgeDocContent }>(
    { status: 'loading' },
  )

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

  const obsidianUri =
    source === 'vault'
      ? `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(doc.path.replace(/\.md$/i, ''))}`
      : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:p-8"
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
        </div>
      </div>
    </div>
  )
}

function SourceBody({
  source,
  onOpen,
}: {
  source: KnowledgeSource
  onOpen: (doc: KnowledgeDocMeta) => void
}) {
  if (!source.available) {
    return (
      <p className="font-mono text-xs text-neutral-500">
        {String((source.meta as { message?: string }).message ?? 'Source unavailable.')}
      </p>
    )
  }
  return (
    <div className="space-y-4">
      {source.categories.map((cat) => (
        <div key={cat.id}>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="size-2 rounded-full" style={{ backgroundColor: cat.color }} aria-hidden />
            <span className="font-mono text-[11px] tracking-[0.15em] text-neutral-400 uppercase">{cat.name}</span>
            <span className="font-mono text-[10px] text-neutral-600">
              {cat.docs.length} {cat.docs.length === 1 ? 'doc' : 'docs'}
            </span>
          </div>
          {cat.docs.length === 0 ? (
            <p className="pl-4 font-mono text-[10px] text-neutral-600">structure only — no docs baked</p>
          ) : (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {cat.docs.map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  onClick={() => onOpen(doc)}
                  className="group rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-left transition-colors hover:border-neutral-700 hover:bg-neutral-800/40"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-[11px] text-neutral-200">{doc.name}</span>
                    {!doc.contentExtracted && <Pill tone="neutral" label="stub" />}
                  </div>
                  {doc.summary && (
                    <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-neutral-500">{doc.summary}</p>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

export function KnowledgePanel() {
  const state = useApiGet<KnowledgeSourcesResponse>('/api/knowledge/sources')
  const [active, setActive] = useState<KnowledgeSourceId>('drive')
  const [openDoc, setOpenDoc] = useState<KnowledgeDocMeta | null>(null)
  const [exportMsg, setExportMsg] = useState<string | null>(null)

  const sources = state.status === 'success' ? state.data.sources : []
  const current = sources.find((s) => s.id === active)
  const vaultName = vaultNameFromPath(sources.find((s) => s.id === 'vault')?.meta.path)

  async function doExport(): Promise<void> {
    setExportMsg('Exporting…')
    try {
      const r = await apiPost<{ export: { file: string; sizeBytes: number } }>('/api/knowledge/export')
      setExportMsg(`Baked bundle written: ${r.export.file} (${r.export.sizeBytes} bytes)`)
    } catch (e) {
      setExportMsg(e instanceof Error ? e.message : String(e))
    }
  }

  const pill =
    state.status === 'loading'
      ? ({ tone: 'amber', label: 'Loading' } as const)
      : state.status === 'error'
        ? ({ tone: 'red', label: 'Error' } as const)
        : ({ tone: 'green', label: 'Live' } as const)

  return (
    <Panel title="Knowledge — Drive + Vault" pill={pill}>
      {state.status === 'error' && <p className="font-mono text-xs text-red-400">{state.message}</p>}
      {state.status === 'success' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {sources.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setActive(s.id)}
                className={`rounded border px-3 py-1 font-mono text-[10px] tracking-widest uppercase transition-colors ${
                  active === s.id
                    ? 'border-copper-500/50 bg-copper-500/10 text-copper-300'
                    : 'border-neutral-800 text-neutral-500 hover:bg-neutral-800/40'
                }`}
              >
                {s.label}
              </button>
            ))}
            <span className="grow" />
            {active === 'drive' && current?.available && (
              <button
                type="button"
                onClick={() => void doExport()}
                className="rounded border border-neutral-700 px-2 py-1 font-mono text-[10px] tracking-wider text-neutral-400 uppercase hover:bg-neutral-800"
              >
                Export baked bundle
              </button>
            )}
          </div>

          {active === 'drive' && current?.available && (
            <p className="font-mono text-[10px] text-neutral-600">
              read-only snapshot · owner {String(current.meta.owner ?? '—')} · baked{' '}
              {typeof current.meta.generatedAt === 'string' ? current.meta.generatedAt.slice(0, 16).replace('T', ' ') : '—'}
            </p>
          )}
          {exportMsg && <p className="font-mono text-[10px] break-all text-neutral-500">{exportMsg}</p>}

          {current && <SourceBody source={current} onOpen={setOpenDoc} />}
        </div>
      )}

      {openDoc && (
        <DocModal source={active} doc={openDoc} vaultName={vaultName} onClose={() => setOpenDoc(null)} />
      )}
    </Panel>
  )
}
