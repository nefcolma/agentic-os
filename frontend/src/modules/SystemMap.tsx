import { useMemo, useState } from 'react'
import { useApiGet } from '../lib/api'
import type {
  SystemMapResponse,
  SystemNode,
  SystemNodeStatus,
  SystemNodeType,
  SystemVerificationStatus,
} from '../lib/types'
import { Panel, Pill, KeyValue } from '../components/ui'
import type { PillTone } from '../components/ui'

/**
 * System Map — operational wiring of the agentic OS, separate from the
 * Knowledge Map (which stays a document/wikilink view). Pillars are laid out
 * as columns: Applications → Skills → Routines → Memory. Pure React + SVG,
 * no graph library. Only operative components are shown — vault documents
 * are never loaded as nodes.
 *
 * Edge honesty is visual: verified = solid, declared = dashed,
 * unresolved = faint amber. Selecting an edge shows its evidence.
 */

const COLUMNS: SystemNodeType[] = ['application', 'skill', 'routine', 'memory']

const COLUMN_LABEL: Record<SystemNodeType, string> = {
  application: 'Applications',
  skill: 'Skills',
  routine: 'Routines',
  memory: 'Memory',
}

/** One accent per pillar — copper stays the routine (action) color. */
const TYPE_COLOR: Record<SystemNodeType, string> = {
  application: '#38bdf8', // sky-400
  skill: '#a78bfa', // violet-400
  routine: '#d29a63', // copper-400
  memory: '#34d399', // emerald-400
}

const STATUS_TONE: Record<SystemNodeStatus, PillTone> = {
  active: 'green',
  available: 'green',
  manual: 'copper',
  not_configured: 'amber',
  missing: 'red',
  stale: 'amber',
  disabled: 'neutral',
}

const STATUS_DOT: Record<SystemNodeStatus, string> = {
  active: '#34d399',
  available: '#6ee7b7',
  manual: '#d29a63',
  not_configured: '#fbbf24',
  missing: '#f87171',
  stale: '#fbbf24',
  disabled: '#737373',
}

const VERIFICATION_TONE: Record<SystemVerificationStatus, PillTone> = {
  verified: 'green',
  declared: 'amber',
  unresolved: 'red',
}

const ALL_STATUSES: SystemNodeStatus[] = [
  'active',
  'available',
  'manual',
  'not_configured',
  'missing',
  'stale',
  'disabled',
]

// ── Layout constants (SVG user units) ─────────────────────────────────────
const NODE_W = 176
const NODE_H = 52
const ROW_GAP = 26
const COL_GAP = 84
const PAD_X = 16
const PAD_TOP = 44

interface Placed {
  node: SystemNode
  x: number
  y: number
}

function layout(nodes: SystemNode[]): { placed: Map<string, Placed>; width: number; height: number } {
  const placed = new Map<string, Placed>()
  let maxRows = 1
  COLUMNS.forEach((type, col) => {
    const colNodes = nodes.filter((n) => n.type === type)
    maxRows = Math.max(maxRows, colNodes.length)
    colNodes.forEach((node, row) => {
      placed.set(node.id, {
        node,
        x: PAD_X + col * (NODE_W + COL_GAP),
        y: PAD_TOP + row * (NODE_H + ROW_GAP),
      })
    })
  })
  return {
    placed,
    width: PAD_X * 2 + COLUMNS.length * NODE_W + (COLUMNS.length - 1) * COL_GAP,
    height: PAD_TOP + maxRows * (NODE_H + ROW_GAP) + 8,
  }
}

/** Bezier from source box edge to target box edge, in either direction. */
function edgePath(a: Placed, b: Placed): { d: string; mid: { x: number; y: number } } {
  const leftToRight = a.x <= b.x
  const x1 = leftToRight ? a.x + NODE_W : a.x
  const y1 = a.y + NODE_H / 2
  const x2 = leftToRight ? b.x : b.x + NODE_W
  const y2 = b.y + NODE_H / 2
  const dx = Math.max(36, Math.abs(x2 - x1) / 2)
  const c1x = x1 + (leftToRight ? dx : -dx)
  const c2x = x2 + (leftToRight ? -dx : dx)
  return {
    d: `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`,
    mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 },
  }
}

function edgeStroke(v: SystemVerificationStatus, highlighted: boolean): {
  stroke: string
  dash?: string
  opacity: number
  width: number
} {
  const base = highlighted ? 1 : 0.55
  switch (v) {
    case 'verified':
      return { stroke: '#8a8f98', opacity: base, width: highlighted ? 2 : 1.4 }
    case 'declared':
      return { stroke: '#8a8f98', dash: '6 5', opacity: base * 0.9, width: highlighted ? 2 : 1.3 }
    case 'unresolved':
      return { stroke: '#fbbf24', dash: '2 5', opacity: highlighted ? 0.9 : 0.35, width: highlighted ? 2 : 1.2 }
  }
}

function FilterChip({ active, color, label, onClick }: { active: boolean; color?: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10px] tracking-widest uppercase transition-colors ${
        active
          ? 'border-neutral-500 bg-neutral-800 text-neutral-100'
          : 'border-neutral-800 bg-neutral-900/40 text-neutral-500 hover:text-neutral-300'
      }`}
    >
      {color && <span className="size-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden />}
      {label}
    </button>
  )
}

export function SystemMap() {
  const state = useApiGet<SystemMapResponse>('/api/system-map', 60_000)
  const [typeFilter, setTypeFilter] = useState<Set<SystemNodeType>>(new Set(COLUMNS))
  const [statusFilter, setStatusFilter] = useState<Set<SystemNodeStatus>>(new Set(ALL_STATUSES))
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null)

  const map = state.status === 'success' ? state.data : null

  const visibleNodes = useMemo(() => {
    if (!map) return []
    return map.nodes.filter((n) => typeFilter.has(n.type) && statusFilter.has(n.status))
  }, [map, typeFilter, statusFilter])

  const { placed, width, height } = useMemo(() => layout(visibleNodes), [visibleNodes])

  const visibleEdges = useMemo(() => {
    if (!map) return []
    return map.edges.filter((e) => placed.has(e.source) && placed.has(e.target))
  }, [map, placed])

  const node = map?.nodes.find((n) => n.id === selectedNode) ?? null
  const edge = map?.edges.find((e) => e.id === selectedEdge) ?? null
  const relatedEdges = node && map ? map.edges.filter((e) => e.source === node.id || e.target === node.id) : []

  const toggle = <T,>(set: Set<T>, value: T, update: (next: Set<T>) => void): void => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    update(next)
  }

  const labelFor = (id: string): string => map?.nodes.find((n) => n.id === id)?.label ?? id

  return (
    <div className="space-y-4">
      <Panel
        title="System Map"
        pill={
          state.status === 'loading'
            ? { tone: 'amber', label: 'Loading' }
            : state.status === 'error'
              ? { tone: 'red', label: 'Error' }
              : { tone: 'green', label: `${map?.nodes.length ?? 0} nodes` }
        }
      >
        <p className="mb-3 font-mono text-[11px] leading-relaxed text-neutral-500">
          Operational wiring of the agentic OS — which applications feed which skills, which routines use them,
          and which memory they consume or produce. Solid lines are <span className="text-neutral-300">verified</span> against
          specs, tool scopes and the filesystem; dashed lines are <span className="text-neutral-300">declared</span> only;
          faint amber lines are <span className="text-amber-400">unresolved</span>.
        </p>

        {state.status === 'loading' && (
          <p className="font-mono text-xs text-neutral-500">Building the system map…</p>
        )}
        {state.status === 'error' && (
          <p className="font-mono text-xs text-red-400">Could not load the system map: {state.message}</p>
        )}

        {map && (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 font-mono text-[10px] tracking-widest text-neutral-600 uppercase">Type</span>
              {COLUMNS.map((t) => (
                <FilterChip
                  key={t}
                  active={typeFilter.has(t)}
                  color={TYPE_COLOR[t]}
                  label={`${COLUMN_LABEL[t]} (${map.counts[t]})`}
                  onClick={() => toggle(typeFilter, t, setTypeFilter)}
                />
              ))}
            </div>
            <div className="mb-4 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 font-mono text-[10px] tracking-widest text-neutral-600 uppercase">Status</span>
              {ALL_STATUSES.filter((s) => map.nodes.some((n) => n.status === s)).map((s) => (
                <FilterChip
                  key={s}
                  active={statusFilter.has(s)}
                  color={STATUS_DOT[s]}
                  label={s.replace('_', ' ')}
                  onClick={() => toggle(statusFilter, s, setStatusFilter)}
                />
              ))}
            </div>

            {visibleNodes.length === 0 ? (
              <p className="rounded border border-neutral-800 bg-neutral-900/40 p-6 text-center font-mono text-xs text-neutral-500">
                Nothing matches the current filters.
              </p>
            ) : (
              <div className="overflow-x-auto rounded border border-neutral-800 bg-neutral-950/60">
                <svg
                  viewBox={`0 0 ${width} ${height}`}
                  className="block h-auto w-full"
                  style={{ minWidth: 720 }}
                  role="img"
                  aria-label="System map of applications, skills, routines and memory"
                >
                  {/* Column headers */}
                  {COLUMNS.map((type, col) =>
                    typeFilter.has(type) ? (
                      <text
                        key={type}
                        x={PAD_X + col * (NODE_W + COL_GAP) + NODE_W / 2}
                        y={22}
                        textAnchor="middle"
                        className="font-mono uppercase"
                        style={{ fontSize: 11, letterSpacing: '0.2em', fill: TYPE_COLOR[type] }}
                      >
                        {COLUMN_LABEL[type]}
                      </text>
                    ) : null,
                  )}

                  {/* Edges under nodes */}
                  {visibleEdges.map((e) => {
                    const a = placed.get(e.source)!
                    const b = placed.get(e.target)!
                    const { d, mid } = edgePath(a, b)
                    const highlighted =
                      e.id === selectedEdge || e.source === selectedNode || e.target === selectedNode
                    const s = edgeStroke(e.verification, highlighted)
                    return (
                      <g
                        key={e.id}
                        className="cursor-pointer"
                        onClick={() => {
                          setSelectedEdge(e.id === selectedEdge ? null : e.id)
                          setSelectedNode(null)
                        }}
                      >
                        {/* wide invisible hit area */}
                        <path d={d} fill="none" stroke="transparent" strokeWidth={12} />
                        <path
                          d={d}
                          fill="none"
                          stroke={s.stroke}
                          strokeWidth={s.width}
                          strokeDasharray={s.dash}
                          opacity={s.opacity}
                        />
                        {e.verification === 'unresolved' && (
                          <text
                            x={mid.x}
                            y={mid.y - 4}
                            textAnchor="middle"
                            style={{ fontSize: 9, fill: '#fbbf24', opacity: highlighted ? 1 : 0.7 }}
                            className="font-mono"
                          >
                            ⚠ unresolved
                          </text>
                        )}
                        {highlighted && e.verification !== 'unresolved' && (
                          <text
                            x={mid.x}
                            y={mid.y - 4}
                            textAnchor="middle"
                            style={{ fontSize: 9, fill: '#a3a3a3' }}
                            className="font-mono"
                          >
                            {e.relationship}
                          </text>
                        )}
                      </g>
                    )
                  })}

                  {/* Nodes */}
                  {[...placed.values()].map(({ node: n, x, y }) => {
                    const selected = n.id === selectedNode
                    const color = TYPE_COLOR[n.type]
                    return (
                      <g
                        key={n.id}
                        className="cursor-pointer"
                        onClick={() => {
                          setSelectedNode(selected ? null : n.id)
                          setSelectedEdge(null)
                        }}
                      >
                        <rect
                          x={x}
                          y={y}
                          rx={8}
                          width={NODE_W}
                          height={NODE_H}
                          fill={selected ? '#1f1f22' : '#161618'}
                          stroke={selected ? color : '#2a2a2e'}
                          strokeWidth={selected ? 1.6 : 1}
                        />
                        <rect x={x} y={y} rx={2} width={3} height={NODE_H} fill={color} opacity={0.85} />
                        <text
                          x={x + 12}
                          y={y + 21}
                          className="font-mono"
                          style={{ fontSize: 12, fill: '#e5e5e5', fontWeight: 600 }}
                        >
                          {n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}
                        </text>
                        <circle cx={x + 15} cy={y + 37} r={3} fill={STATUS_DOT[n.status]} />
                        <text
                          x={x + 23}
                          y={y + 40}
                          className="font-mono uppercase"
                          style={{ fontSize: 9, letterSpacing: '0.12em', fill: '#8a8f98' }}
                        >
                          {n.status.replace('_', ' ')}
                          {n.company ? ` · ${n.company}` : ''}
                        </text>
                      </g>
                    )
                  })}
                </svg>
              </div>
            )}

            {map.warnings.length > 0 && (
              <div className="mt-3 space-y-1">
                {map.warnings.map((w) => (
                  <p key={w} className="font-mono text-[11px] text-amber-400/80">
                    ⚠ {w}
                  </p>
                ))}
              </div>
            )}
          </>
        )}
      </Panel>

      {node && (
        <Panel title={node.label} pill={{ tone: STATUS_TONE[node.status], label: node.status.replace('_', ' ') }}>
          <p className="mb-3 text-sm leading-relaxed text-neutral-300">{node.description}</p>
          <KeyValue label="Type">
            <span style={{ color: TYPE_COLOR[node.type] }}>{COLUMN_LABEL[node.type]}</span>
          </KeyValue>
          {node.company && <KeyValue label="Company">{node.company}</KeyValue>}
          {Object.entries(node.metadata)
            .filter(([, v]) => v !== null && v !== '')
            .map(([k, v]) => (
              <KeyValue key={k} label={k}>
                <span className="break-all">{String(v)}</span>
              </KeyValue>
            ))}
          {relatedEdges.length > 0 && (
            <div className="mt-3">
              <h3 className="mb-1.5 font-mono text-[10px] tracking-widest text-neutral-500 uppercase">Relationships</h3>
              <div className="space-y-1">
                {relatedEdges.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => {
                      setSelectedEdge(e.id)
                      setSelectedNode(null)
                    }}
                    className="flex w-full items-center justify-between gap-3 rounded border border-neutral-800 bg-neutral-900/40 px-2.5 py-1.5 text-left font-mono text-[11px] text-neutral-300 hover:border-neutral-600"
                  >
                    <span>
                      {labelFor(e.source)} <span className="text-neutral-500">—{e.relationship}→</span> {labelFor(e.target)}
                    </span>
                    <Pill tone={VERIFICATION_TONE[e.verification]} label={e.verification} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </Panel>
      )}

      {edge && (
        <Panel
          title={`${labelFor(edge.source)} → ${labelFor(edge.target)}`}
          pill={{ tone: VERIFICATION_TONE[edge.verification], label: edge.verification }}
        >
          <KeyValue label="Relationship">{edge.relationship}</KeyValue>
          <div className="mt-3">
            <h3 className="mb-1.5 font-mono text-[10px] tracking-widest text-neutral-500 uppercase">Evidence</h3>
            <div className="space-y-2">
              {edge.evidence.map((ev, i) => (
                <div key={i} className="rounded border border-neutral-800 bg-neutral-900/40 p-2.5">
                  <div className="mb-1 flex items-center gap-2">
                    <Pill tone="neutral" label={ev.kind.replace(/_/g, ' ')} />
                    <span className="break-all font-mono text-[10px] text-neutral-500">{ev.reference}</span>
                  </div>
                  <p className="font-mono text-[11px] leading-relaxed text-neutral-300">{ev.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      )}
    </div>
  )
}
