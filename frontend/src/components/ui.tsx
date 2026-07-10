import type { ReactNode } from 'react'

export type PillTone = 'green' | 'amber' | 'red' | 'copper' | 'neutral'

const PILL_STYLES: Record<PillTone, string> = {
  green: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
  amber: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  red: 'border-red-500/40 bg-red-500/10 text-red-400',
  copper: 'border-copper-500/40 bg-copper-500/10 text-copper-400',
  neutral: 'border-neutral-700 bg-neutral-800/60 text-neutral-400',
}

export function Pill({ tone, label }: { tone: PillTone; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium tracking-widest uppercase ${PILL_STYLES[tone]}`}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </span>
  )
}

export function Panel({
  title,
  pill,
  children,
}: {
  title: string
  pill?: { tone: PillTone; label: string }
  children: ReactNode
}) {
  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-mono text-xs font-semibold tracking-[0.2em] text-neutral-400 uppercase">
          {title}
        </h2>
        {pill && <Pill tone={pill.tone} label={pill.label} />}
      </header>
      {children}
    </section>
  )
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-neutral-800/70 py-1.5 last:border-b-0">
      <span className="font-mono text-[11px] tracking-wider text-neutral-500 uppercase">{label}</span>
      <span className="text-right font-mono text-xs text-neutral-200">{children}</span>
    </div>
  )
}

/** Maps a note's frontmatter `status` to a pill tone. Unknown statuses stay neutral. */
export function statusTone(status: string | null): PillTone {
  switch ((status ?? '').toLowerCase()) {
    case 'active':
    case 'live':
      return 'green'
    case 'waiting':
    case 'on-hold':
    case 'paused':
    case 'review':
    case 'stale':
      return 'amber'
    case 'blocked':
    case 'overdue':
      return 'red'
    case 'done':
    case 'completed':
    case 'archived':
      return 'neutral'
    default:
      return 'neutral'
  }
}
