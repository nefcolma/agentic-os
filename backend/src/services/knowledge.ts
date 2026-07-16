import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import matter from 'gray-matter'
import { config } from '../config/index.js'
import { redactSecrets } from '../utils/redact.js'

/**
 * KnowledgeService — the "knowledge viewer" data layer. Exposes TWO strictly
 * separated sources (never merged, per the vault separation rules):
 *
 *   1. drive  — a local, gitignored point-in-time snapshot of the shared Drive
 *               "obsidianbus" folder, extracted read-only by the agent. The
 *               backend has no Drive credentials, so it only *serves* the
 *               baked snapshot; it never calls Drive and never writes to Drive.
 *   2. vault  — the local MyBrain Obsidian vault, read fresh from disk.
 *
 * Real content is served only through the backend on localhost; it is never
 * baked into the frontend bundle. Any served text is redacted defensively.
 */

export type KnowledgeSourceId = 'drive' | 'vault'

export interface KnowledgeDocMeta {
  id: string
  name: string
  path: string
  mimeType: string
  sizeBytes: number | null
  modified: string | null
  summary: string
  contentExtracted: boolean
}

export interface KnowledgeCategory {
  id: string
  name: string
  color: string
  note: string
  docs: KnowledgeDocMeta[]
}

export interface KnowledgeSource {
  id: KnowledgeSourceId
  label: string
  kind: KnowledgeSourceId
  available: boolean
  meta: Record<string, unknown>
  categories: KnowledgeCategory[]
}

export interface KnowledgeDocContent extends KnowledgeDocMeta {
  source: KnowledgeSourceId
  content: string | null
  message?: string
}

// ── Drive snapshot ───────────────────────────────────────────────────────

interface SnapshotDoc extends KnowledgeDocMeta {
  driveId?: string
  content: string | null
}
interface SnapshotCategory {
  id: string
  name: string
  color: string
  note: string
  docs: SnapshotDoc[]
}
interface Snapshot {
  schemaVersion: number
  source: Record<string, unknown>
  generatedAt: string
  generatedBy: string
  note: string
  stats: Record<string, number>
  categories: SnapshotCategory[]
}

let snapshotCache: { mtimeMs: number; data: Snapshot } | null = null

function loadSnapshot(): Snapshot | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(config.knowledge.snapshotPath)
  } catch {
    return null
  }
  if (snapshotCache && snapshotCache.mtimeMs === stat.mtimeMs) return snapshotCache.data
  try {
    const data = JSON.parse(fs.readFileSync(config.knowledge.snapshotPath, 'utf8')) as Snapshot
    snapshotCache = { mtimeMs: stat.mtimeMs, data }
    return data
  } catch {
    return null
  }
}

/**
 * The Drive connector escapes markdown punctuation with backslashes
 * (`\#`, `\-`, `\**`). Strip that so the viewer renders clean markdown. A
 * no-op on already-clean content.
 */
function cleanDriveMarkdown(text: string): string {
  return redactSecrets(text.replace(/\\([^A-Za-z0-9\s])/g, '$1'))
}

function driveSource(): KnowledgeSource {
  const snap = loadSnapshot()
  if (!snap) {
    return {
      id: 'drive',
      label: 'Drive — obsidianbus (shared)',
      kind: 'drive',
      available: false,
      meta: { reason: 'no_snapshot', message: 'No knowledge snapshot found. Ask Claude to re-bake it.' },
      categories: [],
    }
  }
  return {
    id: 'drive',
    label: 'Drive — obsidianbus (shared)',
    kind: 'drive',
    available: true,
    meta: {
      ...snap.source,
      generatedAt: snap.generatedAt,
      generatedBy: snap.generatedBy,
      stats: snap.stats,
      note: snap.note,
    },
    categories: snap.categories.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      note: c.note,
      docs: c.docs.map(stripDriveContent),
    })),
  }
}

function stripDriveContent(d: SnapshotDoc): KnowledgeDocMeta {
  return {
    id: d.id,
    name: d.name,
    path: d.path,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    modified: d.modified,
    summary: d.summary,
    contentExtracted: d.contentExtracted,
  }
}

function driveDoc(id: string): KnowledgeDocContent | null {
  const snap = loadSnapshot()
  if (!snap) return null
  for (const c of snap.categories) {
    const d = c.docs.find((x) => x.id === id)
    if (d) {
      return {
        ...stripDriveContent(d),
        source: 'drive',
        content: d.content !== null ? cleanDriveMarkdown(d.content) : null,
        message: d.content === null ? 'Content not baked in this snapshot — re-bake to include it.' : undefined,
      }
    }
  }
  return null
}

// ── Local vault source ─────────────────────────────────────────────────────

const VAULT_CATEGORIES: Array<{ id: string; name: string; folder: string; color: string; note: string }> = [
  { id: 'v-inbox', name: '0_Inbox', folder: '0_Inbox', color: '#9ca3af', note: 'New items awaiting processing.' },
  { id: 'v-meta', name: '0_Meta', folder: '0_Meta', color: '#e8c56a', note: 'USER / SOUL / IDENTITY / operating context.' },
  { id: 'v-projects', name: '1_Projects', folder: '1_Projects', color: '#ff8f6b', note: 'Active projects with deadlines.' },
  { id: 'v-areas', name: '2_Areas', folder: '2_Areas', color: '#7de08a', note: 'Ongoing areas of responsibility.' },
  { id: 'v-resources', name: '3_Resources', folder: '3_Resources', color: '#6bb3ff', note: 'Reference material by topic.' },
]

/** Stable, reversible doc id that encodes the vault-relative path. */
function encodeVaultId(relPath: string): string {
  return 'v-' + Buffer.from(relPath, 'utf8').toString('base64url')
}
function decodeVaultId(id: string): string | null {
  if (!id.startsWith('v-')) return null
  try {
    return Buffer.from(id.slice(2), 'base64url').toString('utf8')
  } catch {
    return null
  }
}

async function listVaultFolder(folder: string): Promise<KnowledgeDocMeta[]> {
  const dirAbs = path.join(config.vaultPath, folder)
  let entries
  try {
    entries = await fsp.readdir(dirAbs, { withFileTypes: true })
  } catch {
    return []
  }
  const docs: KnowledgeDocMeta[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    const relPath = path.join(folder, entry.name)
    const abs = path.join(dirAbs, entry.name)
    let summary = ''
    let stat
    try {
      stat = await fsp.stat(abs)
      const parsed = matter(await fsp.readFile(abs, 'utf8'))
      const data = parsed.data as Record<string, unknown>
      if (typeof data.title === 'string') summary = data.title
      if (Array.isArray(data.tags) && data.tags.length) summary += ` · ${data.tags.join(', ')}`
    } catch {
      // fall through with empty summary
    }
    docs.push({
      id: encodeVaultId(relPath),
      name: entry.name,
      path: relPath,
      mimeType: 'text/markdown',
      sizeBytes: stat ? stat.size : null,
      modified: stat ? stat.mtime.toISOString() : null,
      summary,
      contentExtracted: true,
    })
  }
  return docs
}

async function vaultSource(): Promise<KnowledgeSource> {
  const available = fs.existsSync(config.vaultPath)
  const categories: KnowledgeCategory[] = []
  if (available) {
    for (const c of VAULT_CATEGORIES) {
      const docs = await listVaultFolder(c.folder)
      categories.push({ id: c.id, name: c.name, color: c.color, note: c.note, docs })
    }
  }
  return {
    id: 'vault',
    label: 'Vault — MyBrain (local)',
    kind: 'vault',
    available,
    meta: { path: config.vaultPath, live: true },
    categories,
  }
}

/**
 * Decodes a vault doc id to a validated { relPath, absPath }, guarding against
 * path traversal and restricting to .md files inside the vault. Shared by the
 * doc reader and the regenerate service.
 */
export function resolveVaultDoc(id: string): { relPath: string; absPath: string } | null {
  const relPath = decodeVaultId(id)
  if (relPath === null) return null
  const abs = path.resolve(config.vaultPath, relPath)
  if (abs !== config.vaultPath && !abs.startsWith(config.vaultPath + path.sep)) return null
  if (!abs.toLowerCase().endsWith('.md')) return null
  return { relPath, absPath: abs }
}

/** Reads one vault note fresh from disk; guards against path traversal. */
async function vaultDoc(id: string): Promise<KnowledgeDocContent | null> {
  const resolved = resolveVaultDoc(id)
  if (!resolved) return null
  const { relPath, absPath: abs } = resolved
  try {
    const [raw, stat] = await Promise.all([fsp.readFile(abs, 'utf8'), fsp.stat(abs)])
    return {
      id,
      name: path.basename(abs),
      path: relPath,
      mimeType: 'text/markdown',
      sizeBytes: stat.size,
      modified: stat.mtime.toISOString(),
      summary: '',
      contentExtracted: true,
      source: 'vault',
      content: redactSecrets(raw),
    }
  } catch {
    return null
  }
}

// ── Public API ───────────────────────────────────────────────────────────

export async function getKnowledgeSources(): Promise<KnowledgeSource[]> {
  return [driveSource(), await vaultSource()]
}

export async function getKnowledgeDoc(
  source: KnowledgeSourceId,
  id: string,
): Promise<KnowledgeDocContent | null> {
  return source === 'drive' ? driveDoc(id) : vaultDoc(id)
}

// ── Knowledge graph (for the constellation / rings visualization) ──────────

export interface GraphNode {
  id: string
  type: 'core' | 'hub' | 'doc'
  label: string
  color: string
  category?: string
  source?: KnowledgeSourceId
  docId?: string
  path?: string
  contentExtracted?: boolean
}
export interface GraphLink {
  source: string
  target: string
  kind: 'spine' | 'branch' | 'ref'
}
export interface KnowledgeGraph {
  source: KnowledgeSourceId
  available: boolean
  coreId: string
  coreLabel: string
  nodes: GraphNode[]
  links: GraphLink[]
  stats: { nodes: number; hubs: number; docs: number; crossRefs: number }
}

const norm = (s: string): string => s.replace(/\.md$/i, '').trim().toLowerCase().replace(/[\s_-]+/g, ' ')

/**
 * Builds a node/link graph for one source. Structure links (core→hub→doc) are
 * always real; cross-reference links come from actual `[[wikilinks]]` parsed
 * from document content (only where content is available) — never invented.
 */
export async function getKnowledgeGraph(sourceId: KnowledgeSourceId): Promise<KnowledgeGraph> {
  const sources = await getKnowledgeSources()
  const src = sources.find((s) => s.id === sourceId)
  const coreLabel = sourceId === 'drive' ? 'INDEX.md' : 'CLAUDE.md'
  const coreId = 'core'
  const nodes: GraphNode[] = [{ id: coreId, type: 'core', label: coreLabel, color: '#e8c56a' }]
  const links: GraphLink[] = []

  if (!src || !src.available) {
    return { source: sourceId, available: false, coreId, coreLabel, nodes, links, stats: { nodes: 1, hubs: 0, docs: 0, crossRefs: 0 } }
  }

  const nameToNode = new Map<string, string>()
  let hubs = 0
  let docCount = 0
  for (const cat of src.categories) {
    const hubId = `hub-${cat.id}`
    nodes.push({ id: hubId, type: 'hub', label: cat.name, color: cat.color, category: cat.id })
    links.push({ source: coreId, target: hubId, kind: 'spine' })
    hubs++
    for (const doc of cat.docs) {
      const nodeId = `doc-${doc.id}`
      nodes.push({
        id: nodeId,
        type: 'doc',
        label: doc.name.replace(/\.md$/i, ''),
        color: cat.color,
        category: cat.id,
        source: sourceId,
        docId: doc.id,
        path: doc.path,
        contentExtracted: doc.contentExtracted,
      })
      links.push({ source: hubId, target: nodeId, kind: 'branch' })
      nameToNode.set(norm(doc.name), nodeId)
      docCount++
    }
  }

  // Cross-references from real [[wikilinks]] in available content.
  let crossRefs = 0
  const seenPairs = new Set<string>()
  for (const cat of src.categories) {
    for (const doc of cat.docs) {
      if (sourceId === 'drive' && !doc.contentExtracted) continue
      const content = await getKnowledgeDoc(sourceId, doc.id)
      if (!content || content.content === null) continue
      const fromId = `doc-${doc.id}`
      for (const m of content.content.matchAll(/\[\[([^\]|#]+)/g)) {
        const target = nameToNode.get(norm(m[1] ?? ''))
        const pair = `${fromId}->${target}`
        if (target && target !== fromId && !seenPairs.has(pair)) {
          seenPairs.add(pair)
          links.push({ source: fromId, target, kind: 'ref' })
          crossRefs++
        }
      }
    }
  }

  return {
    source: sourceId,
    available: true,
    coreId,
    coreLabel,
    nodes,
    links,
    stats: { nodes: nodes.length, hubs, docs: docCount, crossRefs },
  }
}

export interface ExportResult {
  file: string
  sizeBytes: number
  generatedAt: string
}

/**
 * "Hybrid" export: writes a portable, self-contained baked bundle of the Drive
 * snapshot to the gitignored export dir. Never committed, never auto-shared.
 */
export async function exportBakedBundle(): Promise<ExportResult> {
  const snap = loadSnapshot()
  if (!snap) throw new Error('No knowledge snapshot to export.')
  await fsp.mkdir(config.knowledge.exportDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(config.knowledge.exportDir, `knowledge-baked-${stamp}.json`)
  const bundle = {
    ...snap,
    exportedAt: new Date().toISOString(),
    exportNote: 'Portable baked bundle. Contains real business data — do not commit or share without authorization.',
  }
  const json = JSON.stringify(bundle, null, 2)
  await fsp.writeFile(file, json, 'utf8')
  return { file, sizeBytes: Buffer.byteLength(json), generatedAt: bundle.exportedAt }
}
