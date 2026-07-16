import { useEffect, useMemo, useRef, useState } from 'react'
import { useApiGet } from '../lib/api'
import type { KnowledgeGraph, GraphNode, KnowledgeSourceId, KnowledgeDocMeta } from '../lib/types'
import { DocModal } from '../components/DocModal'

type Layout = 'rings' | 'constellation'
interface Pt {
  x: number
  y: number
}

const R_HUB = 150
const R_DOC_BASE = 232
const VIEW = 760 // viewBox is -VIEW/2 … VIEW/2

function rotate(p: Pt, deg: number): Pt {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }
}

/** Deterministic ring layout: hubs on an inner ring, docs fanned in each hub's sector. */
function layoutRings(graph: KnowledgeGraph): Map<string, Pt> {
  const pos = new Map<string, Pt>()
  pos.set(graph.coreId, { x: 0, y: 0 })
  const hubs = graph.nodes.filter((n) => n.type === 'hub')
  hubs.forEach((hub, hi) => {
    const base = (2 * Math.PI * hi) / Math.max(hubs.length, 1) - Math.PI / 2
    pos.set(hub.id, { x: Math.cos(base) * R_HUB, y: Math.sin(base) * R_HUB })
    const docs = graph.nodes.filter((n) => n.type === 'doc' && n.category === hub.category)
    const spread = Math.min(0.85, 0.32 + docs.length * 0.06)
    docs.forEach((d, di) => {
      const t = docs.length === 1 ? 0 : di / (docs.length - 1) - 0.5
      const a = base + t * spread
      const r = R_DOC_BASE + (di % 3) * 34 + (docs.length > 6 ? (di % 2) * 26 : 0)
      pos.set(d.id, { x: Math.cos(a) * r, y: Math.sin(a) * r })
    })
  })
  return pos
}

/** Seeded force relaxation for the organic "constellation" look (no d3 dependency). */
function layoutConstellation(graph: KnowledgeGraph): Map<string, Pt> {
  const nodes = graph.nodes
  const idx = new Map(nodes.map((n, i) => [n.id, i]))
  // seeded initial scatter
  const P = nodes.map((n, i) => {
    if (n.id === graph.coreId) return { x: 0, y: 0 }
    const a = (i * 2.399963) % (Math.PI * 2) // golden-angle spread
    const r = n.type === 'hub' ? 120 : 190 + ((i * 53) % 140)
    return { x: Math.cos(a) * r, y: Math.sin(a) * r }
  })
  const links = graph.links.map((l) => ({ s: idx.get(l.source)!, t: idx.get(l.target)!, kind: l.kind }))
  for (let iter = 0; iter < 140; iter++) {
    // repulsion
    for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        let dx = P[i]!.x - P[j]!.x
        let dy = P[i]!.y - P[j]!.y
        let d2 = dx * dx + dy * dy || 0.01
        const f = 5200 / d2
        const d = Math.sqrt(d2)
        dx /= d
        dy /= d
        P[i]!.x += dx * f
        P[i]!.y += dy * f
        P[j]!.x -= dx * f
        P[j]!.y -= dy * f
      }
    }
    // springs
    for (const l of links) {
      const rest = l.kind === 'spine' ? 130 : l.kind === 'branch' ? 74 : 150
      const a = P[l.s]!
      const b = P[l.t]!
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01
      const f = (d - rest) * 0.06
      const ux = (dx / d) * f
      const uy = (dy / d) * f
      a.x += ux
      a.y += uy
      b.x -= ux
      b.y -= uy
    }
    P[idx.get(graph.coreId)!] = { x: 0, y: 0 } // pin core
  }
  const pos = new Map<string, Pt>()
  nodes.forEach((n, i) => pos.set(n.id, P[i]!))
  return pos
}

function nodeRadius(n: GraphNode): number {
  return n.type === 'core' ? 26 : n.type === 'hub' ? 8 : 5
}

export function KnowledgeMap() {
  const [source, setSource] = useState<KnowledgeSourceId>('drive')
  const graphState = useApiGet<KnowledgeGraph>(`/api/knowledge/graph?source=${source}`)
  const [layout, setLayout] = useState<Layout>('rings')
  const [spin, setSpin] = useState(20)
  const [autoSpin, setAutoSpin] = useState(false)
  const [showNames, setShowNames] = useState(true)
  const [hover, setHover] = useState<string | null>(null)
  const [openDoc, setOpenDoc] = useState<{ meta: KnowledgeDocMeta; source: KnowledgeSourceId } | null>(null)
  const raf = useRef<number | null>(null)

  const graph = graphState.status === 'success' ? graphState.data : null

  useEffect(() => {
    if (!autoSpin) return
    const tick = (): void => {
      setSpin((s) => (s + 0.15) % 360)
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current)
    }
  }, [autoSpin])

  const basePos = useMemo(() => {
    if (!graph) return new Map<string, Pt>()
    return layout === 'rings' ? layoutRings(graph) : layoutConstellation(graph)
  }, [graph, layout])

  const pos = useMemo(() => {
    const m = new Map<string, Pt>()
    for (const [id, p] of basePos) m.set(id, id === graph?.coreId ? p : rotate(p, spin))
    return m
  }, [basePos, spin, graph?.coreId])

  // neighbor highlight set
  const neighbors = useMemo(() => {
    if (!graph || !hover) return null
    const set = new Set<string>([hover])
    for (const l of graph.links) {
      if (l.source === hover) set.add(l.target)
      if (l.target === hover) set.add(l.source)
    }
    return set
  }, [graph, hover])

  const nodeById = useMemo(() => new Map(graph?.nodes.map((n) => [n.id, n]) ?? []), [graph])

  function openNode(n: GraphNode): void {
    if (n.type !== 'doc' || !n.docId || !n.source) return
    setOpenDoc({
      source: n.source,
      meta: {
        id: n.docId,
        name: n.label.endsWith('.md') ? n.label : `${n.label}.md`,
        path: n.path ?? n.label,
        mimeType: 'text/markdown',
        sizeBytes: null,
        modified: null,
        summary: '',
        contentExtracted: n.contentExtracted ?? false,
      },
    })
  }

  const dim = (id: string): boolean => neighbors !== null && !neighbors.has(id)

  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-950/70">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-800 px-4 py-3">
        <div className="flex items-center gap-3">
          <h2 className="font-mono text-xs font-semibold tracking-[0.25em] text-neutral-300 uppercase">
            Knowledge Map
          </h2>
          <div className="flex gap-1">
            {(['drive', 'vault'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSource(s)}
                className={`rounded border px-2 py-0.5 font-mono text-[10px] tracking-wider uppercase transition-colors ${
                  source === s
                    ? 'border-copper-500/50 bg-copper-500/10 text-copper-300'
                    : 'border-neutral-800 text-neutral-500 hover:bg-neutral-800/40'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        {graph && (
          <span className="font-mono text-[11px] tracking-wider text-neutral-500">
            {graph.stats.docs} NODES · {graph.stats.crossRefs} CROSS-LINKS
          </span>
        )}
      </header>

      <div className="relative">
        {graphState.status === 'loading' && (
          <p className="p-6 font-mono text-xs text-neutral-500">Building knowledge map…</p>
        )}
        {graphState.status === 'error' && (
          <p className="p-6 font-mono text-xs text-red-400">{graphState.message}</p>
        )}
        {graph && !graph.available && (
          <p className="p-6 font-mono text-xs text-neutral-500">
            No snapshot for this source. Ask Claude to re-bake it.
          </p>
        )}

        {graph && graph.available && (
          <svg
            viewBox={`${-VIEW / 2} ${-VIEW / 2} ${VIEW} ${VIEW}`}
            className="block h-[62vh] max-h-[640px] min-h-[440px] w-full"
            preserveAspectRatio="xMidYMid meet"
          >
            <defs>
              <radialGradient id="km-core" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#3a3220" />
                <stop offset="70%" stopColor="#1a160e" />
                <stop offset="100%" stopColor="#0a0a0a" />
              </radialGradient>
              <filter id="km-glow" x="-120%" y="-120%" width="340%" height="340%">
                <feGaussianBlur stdDeviation="3.2" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* guide rings (rings layout only) */}
            {layout === 'rings' &&
              [R_HUB, R_DOC_BASE, R_DOC_BASE + 68, R_DOC_BASE + 120].map((r) => (
                <circle key={r} cx={0} cy={0} r={r} fill="none" stroke="#1f1f1f" strokeWidth={1} />
              ))}

            {/* links */}
            <g>
              {graph.links.map((l, i) => {
                const a = pos.get(l.source)
                const b = pos.get(l.target)
                if (!a || !b) return null
                const active = neighbors !== null && neighbors.has(l.source) && neighbors.has(l.target)
                const faded = neighbors !== null && !active
                const isRef = l.kind === 'ref'
                const stroke = isRef ? '#e8c56a' : nodeById.get(l.target)?.color ?? '#333'
                const baseOp = isRef ? 0.55 : l.kind === 'spine' ? 0.28 : 0.16
                return (
                  <line
                    key={i}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={stroke}
                    strokeWidth={isRef ? 1.4 : 1}
                    strokeOpacity={faded ? 0.05 : active ? Math.min(1, baseOp + 0.5) : baseOp}
                  />
                )
              })}
            </g>

            {/* nodes */}
            <g>
              {graph.nodes.map((n) => {
                const p = pos.get(n.id)
                if (!p) return null
                const r = nodeRadius(n)
                const isHover = hover === n.id
                const faded = dim(n.id)
                if (n.type === 'core') {
                  return (
                    <g key={n.id}>
                      <circle cx={p.x} cy={p.y} r={r + 12} fill="url(#km-core)" />
                      <circle cx={p.x} cy={p.y} r={r} fill="#0a0a0a" stroke="#e8c56a" strokeWidth={1.5} filter="url(#km-glow)" />
                      <text x={p.x} y={p.y - 2} textAnchor="middle" className="fill-neutral-100 font-mono" style={{ fontSize: 11, fontWeight: 700 }}>
                        {n.label}
                      </text>
                      <text x={p.x} y={p.y + 11} textAnchor="middle" className="fill-copper-400 font-mono" style={{ fontSize: 7, letterSpacing: 1.5 }}>
                        SYSTEM CORE
                      </text>
                    </g>
                  )
                }
                const showLabel =
                  n.type === 'hub' || isHover || showNames || (neighbors?.has(n.id) ?? false)
                return (
                  <g
                    key={n.id}
                    style={{ cursor: n.type === 'doc' ? 'pointer' : 'default', opacity: faded ? 0.25 : 1 }}
                    onMouseEnter={() => setHover(n.id)}
                    onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
                    onClick={() => openNode(n)}
                  >
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={isHover ? r + 2.5 : r}
                      fill={n.color}
                      fillOpacity={n.type === 'doc' && n.contentExtracted === false ? 0.35 : 0.95}
                      stroke={n.color}
                      strokeWidth={n.type === 'hub' ? 2 : 1}
                      filter={isHover || n.type === 'hub' ? 'url(#km-glow)' : undefined}
                    />
                    {showLabel && (
                      <text
                        x={p.x}
                        y={p.y + r + (n.type === 'hub' ? 12 : 9)}
                        textAnchor="middle"
                        className="font-mono"
                        style={{
                          fontSize: n.type === 'hub' ? 8.5 : 7.5,
                          fill: n.type === 'hub' ? '#d4d4d4' : '#8a8a8a',
                          letterSpacing: n.type === 'hub' ? 1 : 0,
                          pointerEvents: 'none',
                        }}
                      >
                        {n.type === 'hub'
                          ? `${n.label} · ${graph.nodes.filter((x) => x.type === 'doc' && x.category === n.category).length}`
                          : n.label.length > 22
                            ? `${n.label.slice(0, 21)}…`
                            : n.label}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>
          </svg>
        )}

        {/* controls */}
        {graph && graph.available && (
          <div className="absolute bottom-3 left-3 w-56 rounded-lg border border-neutral-800 bg-neutral-950/85 p-3 backdrop-blur-sm">
            <p className="mb-2 font-mono text-[10px] tracking-[0.2em] text-neutral-500 uppercase">Layout</p>
            <div className="mb-3 flex gap-1">
              {(['rings', 'constellation'] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLayout(l)}
                  className={`flex-1 rounded border px-2 py-1 font-mono text-[10px] tracking-wider capitalize transition-colors ${
                    layout === l
                      ? 'border-copper-500/50 bg-copper-500/10 text-copper-300'
                      : 'border-neutral-800 text-neutral-500 hover:bg-neutral-800/40'
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
            <div className="mb-2 flex items-center justify-between">
              <label className="font-mono text-[10px] tracking-[0.15em] text-neutral-500 uppercase">Spin</label>
              <label className="flex items-center gap-1.5 font-mono text-[10px] text-neutral-500">
                <input type="checkbox" checked={autoSpin} onChange={(e) => setAutoSpin(e.target.checked)} className="accent-copper-500" />
                auto
              </label>
            </div>
            <input
              type="range"
              min={0}
              max={360}
              value={spin}
              onChange={(e) => setSpin(Number(e.target.value))}
              className="mb-3 w-full accent-copper-500"
            />
            <label className="flex items-center gap-2 font-mono text-[11px] text-neutral-300">
              <input type="checkbox" checked={showNames} onChange={(e) => setShowNames(e.target.checked)} className="accent-copper-500" />
              File names
            </label>
            <p className="mt-2 font-mono text-[9px] leading-relaxed text-neutral-600">
              <span className="text-copper-400">Gold lines</span> = content cross-references ([[wikilinks]])
            </p>
          </div>
        )}
      </div>

      {openDoc && (
        <DocModal
          source={openDoc.source}
          doc={openDoc.meta}
          vaultName="MyBrain"
          onClose={() => setOpenDoc(null)}
        />
      )}
    </section>
  )
}
