import { useState } from 'react'
import { useApiGet } from '../lib/api'
import type { QualityScan, QualityIssue, Severity } from '../lib/types'
import { Panel, Pill } from '../components/ui'
import type { PillTone } from '../components/ui'

const SEVERITY_TONE: Record<Severity, PillTone> = {
  critical: 'red',
  high: 'red',
  medium: 'amber',
  low: 'neutral',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2 py-0.5">
      <span className="font-mono text-[10px] tracking-wider text-neutral-500 uppercase">{label}</span>
      <span className="text-[11px] text-neutral-300">{children}</span>
    </div>
  )
}

function IssueCard({ issue }: { issue: QualityIssue }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Pill tone={SEVERITY_TONE[issue.severity]} label={issue.severity} />
          <span className="truncate text-xs text-neutral-200">{issue.title}</span>
        </span>
        <span className="shrink-0 font-mono text-[10px] text-neutral-600">
          {Math.round(issue.confidence * 100)}% · {open ? '−' : '+'}
        </span>
      </button>
      {open && (
        <div className="border-t border-neutral-800 px-3 py-2">
          <p className="mb-2 text-[12px] leading-relaxed text-neutral-300">{issue.description}</p>
          <Field label="Type">
            <span className="font-mono">{issue.issueType}</span> · {issue.category}
          </Field>
          <Field label="Severity">{issue.severity}</Field>
          <Field label="Status">{issue.status}</Field>
          <Field label="Confidence">{Math.round(issue.confidence * 100)}%</Field>
          <Field label="Source">
            {issue.source.type} · {issue.source.dataFreshness} · pulled {new Date(issue.source.pulledAt).toLocaleString()}
          </Field>
          <Field label="Detected">{new Date(issue.detectedAt).toLocaleString()}</Field>
          <Field label="Company">{issue.company}</Field>
          <Field label="Evidence">
            <span className="block">{issue.evidence.summary}</span>
            {issue.evidence.samples.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {issue.evidence.samples.map((s, i) => (
                  <li key={i} className="font-mono text-[10px] break-all text-neutral-500">
                    · {s}
                  </li>
                ))}
              </ul>
            )}
          </Field>
          <Field label="Impact">{issue.businessImpact}</Field>
          <Field label="Metrics">{issue.affectedMetrics.join(' · ')}</Field>
          <Field label="Records">
            {issue.affectedRecordCount ?? '—'}
            {issue.affectedModels.length > 0 && (
              <span className="font-mono text-[10px] text-neutral-600"> ({issue.affectedModels.join(', ')})</span>
            )}
          </Field>
          <Field label="Owner">{issue.proposedOwner ?? '—'}</Field>
          <Field label="Recommendation">{issue.recommendedAction}</Field>
          {issue.correctionRequiresWrite && (
            <p className="mt-2 font-mono text-[10px] text-amber-400">
              ⚠ Any correction is an Odoo write — requires explicit confirmation. Detection only; nothing is changed automatically.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export function QualityPanel() {
  const state = useApiGet<QualityScan>('/api/quality/issues', 300_000)
  const [filter, setFilter] = useState<Severity | 'all'>('all')

  let pill: { tone: PillTone; label: string }
  if (state.status === 'loading') pill = { tone: 'amber', label: 'Scanning' }
  else if (state.status === 'error') pill = { tone: 'red', label: 'Error' }
  else if (state.data.status === 'not_configured') pill = { tone: 'neutral', label: 'Partial' }
  else if (state.data.status === 'error') pill = { tone: 'red', label: 'Unavailable' }
  else pill = { tone: state.data.counts.critical > 0 ? 'red' : 'green', label: 'Live' }

  return (
    <Panel title="Data Quality Center" pill={pill}>
      {state.status === 'loading' && (
        <p className="font-mono text-xs text-neutral-500">Scanning live Odoo data…</p>
      )}
      {state.status === 'error' && <p className="font-mono text-xs text-red-400">{state.message}</p>}

      {state.status === 'success' && (
        <div className="space-y-3">
          {state.data.status === 'not_configured' && (
            <p className="font-mono text-[11px] text-neutral-500">
              {state.data.message} Only snapshot-based checks ran.
            </p>
          )}
          {state.data.status === 'error' && (
            <p className="font-mono text-xs text-red-400">Scan error: {state.data.message}</p>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            {(['all', 'critical', 'high', 'medium', 'low'] as const).map((s) => {
              const n =
                s === 'all' ? state.data.counts.total : state.data.counts[s]
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setFilter(s)}
                  className={`rounded border px-2 py-1 font-mono text-[10px] tracking-wider uppercase transition-colors ${
                    filter === s
                      ? 'border-copper-500/50 bg-copper-500/10 text-copper-300'
                      : 'border-neutral-800 text-neutral-500 hover:bg-neutral-800/40'
                  }`}
                >
                  {s} {n}
                </button>
              )
            })}
            <span className="grow" />
            <span className="font-mono text-[10px] text-neutral-600">
              scanned: {state.data.scanned.join(', ')}
            </span>
          </div>

          {state.data.issues.length === 0 ? (
            <p className="font-mono text-xs text-emerald-400">No data-quality issues detected.</p>
          ) : (
            <div className="space-y-1.5">
              {state.data.issues
                .filter((i) => filter === 'all' || i.severity === filter)
                .map((issue) => (
                  <IssueCard key={issue.issueId} issue={issue} />
                ))}
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}
