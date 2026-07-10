import fs from 'node:fs/promises'
import path from 'node:path'
import matter from 'gray-matter'
import { config } from '../config/index.js'

/**
 * VaultService — deterministic, strictly read-only access to the MyBrain
 * vault. Parses YAML frontmatter (title, created, tags, status) from the
 * PARA folders. Never writes, moves or deletes anything: all mutations go
 * through `claude -p` runs governed by the vault's own CLAUDE.md rules.
 */

export interface NoteSummary {
  /** Path relative to the vault root, e.g. "1_Projects/walnut-urn-line-delay.md" */
  file: string
  title: string
  created: string | null
  tags: string[]
  status: string | null
  modifiedAt: string
  /** False when the note is missing the mandatory YAML frontmatter (vault rule). */
  frontmatterOk: boolean
}

export interface FolderSummary {
  folder: string
  exists: boolean
  count: number
  notes: NoteSummary[]
}

export interface LastConsolidation {
  available: boolean
  /** Vault-relative path of the nightly log the timestamp comes from. */
  logPath: string
  modifiedAt: string | null
  sizeBytes: number | null
}

export interface VaultSummary {
  vaultPath: string
  generatedAt: string
  folders: {
    inbox: FolderSummary
    projects: FolderSummary
    areas: FolderSummary
  }
  lastConsolidation: LastConsolidation
}

export class VaultNotFoundError extends Error {
  constructor(vaultPath: string) {
    super(`Vault not found at ${vaultPath} — check MYBRAIN_VAULT_PATH`)
    this.name = 'VaultNotFoundError'
  }
}

const NIGHTLY_LOG_RELATIVE = path.join('.claude', 'nightly.log')
const MAX_WALK_DEPTH = 4

async function walkMarkdownFiles(dirAbs: string, depth: number): Promise<string[]> {
  if (depth > MAX_WALK_DEPTH) return []
  let entries
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const abs = path.join(dirAbs, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdownFiles(abs, depth + 1)))
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(abs)
    }
  }
  return files
}

function normalizeCreated(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10)
  }
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (typeof value === 'number') return String(value)
  return null
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((tag) => String(tag))
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()]
  return []
}

async function parseNote(absPath: string): Promise<NoteSummary> {
  const relPath = path.relative(config.vaultPath, absPath)
  const [raw, stat] = await Promise.all([fs.readFile(absPath, 'utf8'), fs.stat(absPath)])

  let data: Record<string, unknown> = {}
  let frontmatterOk = true
  try {
    const parsed = matter(raw)
    data = parsed.data as Record<string, unknown>
    frontmatterOk = Object.keys(data).length > 0
  } catch {
    // Malformed YAML — report the note, flag the violation, never crash the summary.
    frontmatterOk = false
  }

  const fallbackTitle = path.basename(absPath, path.extname(absPath))
  return {
    file: relPath,
    title: typeof data.title === 'string' && data.title.trim() !== '' ? data.title.trim() : fallbackTitle,
    created: normalizeCreated(data.created),
    tags: normalizeTags(data.tags),
    status: typeof data.status === 'string' && data.status.trim() !== '' ? data.status.trim() : null,
    modifiedAt: stat.mtime.toISOString(),
    frontmatterOk,
  }
}

/** Most recent first; notes without a created date sort by fs mtime. */
function sortKey(note: NoteSummary): string {
  return note.created ?? note.modifiedAt
}

async function summarizeFolder(folderName: string): Promise<FolderSummary> {
  const dirAbs = path.join(config.vaultPath, folderName)
  let exists = false
  try {
    exists = (await fs.stat(dirAbs)).isDirectory()
  } catch {
    exists = false
  }
  if (!exists) {
    return { folder: folderName, exists: false, count: 0, notes: [] }
  }

  const files = await walkMarkdownFiles(dirAbs, 0)
  const notes = await Promise.all(files.map((file) => parseNote(file)))
  notes.sort((a, b) => sortKey(b).localeCompare(sortKey(a)))
  return { folder: folderName, exists: true, count: notes.length, notes }
}

async function readLastConsolidation(): Promise<LastConsolidation> {
  const logAbs = path.join(config.vaultPath, NIGHTLY_LOG_RELATIVE)
  try {
    const stat = await fs.stat(logAbs)
    return {
      available: true,
      logPath: NIGHTLY_LOG_RELATIVE,
      modifiedAt: stat.mtime.toISOString(),
      sizeBytes: stat.size,
    }
  } catch {
    return { available: false, logPath: NIGHTLY_LOG_RELATIVE, modifiedAt: null, sizeBytes: null }
  }
}

export async function getVaultSummary(): Promise<VaultSummary> {
  try {
    const stat = await fs.stat(config.vaultPath)
    if (!stat.isDirectory()) throw new VaultNotFoundError(config.vaultPath)
  } catch (err) {
    if (err instanceof VaultNotFoundError) throw err
    throw new VaultNotFoundError(config.vaultPath)
  }

  const [inbox, projects, areas, lastConsolidation] = await Promise.all([
    summarizeFolder('0_Inbox'),
    summarizeFolder('1_Projects'),
    summarizeFolder('2_Areas'),
    readLastConsolidation(),
  ])

  return {
    vaultPath: config.vaultPath,
    generatedAt: new Date().toISOString(),
    folders: { inbox, projects, areas },
    lastConsolidation,
  }
}
