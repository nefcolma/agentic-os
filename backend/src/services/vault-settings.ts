import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config/index.js'

/**
 * The ACTIVE vault is runtime state, not a startup constant: any user can point
 * this dashboard at their own vault/folder from the UI, without editing .env or
 * restarting. Every consumer must read the vault through getVaultPath() /
 * vaultPaths() so a change takes effect immediately.
 *
 * Precedence: user choice (data/settings.json) > MYBRAIN_VAULT_PATH env > default.
 */

export type VaultSource = 'user' | 'env' | 'default'

interface PersistedSettings {
  vaultPath?: string
}

const SETTINGS_FILE = path.join(config.dataDir, 'settings.json')

function expandTilde(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

function readPersisted(): PersistedSettings {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as PersistedSettings
  } catch {
    return {}
  }
}

let activeVaultPath: string = (() => {
  const saved = readPersisted().vaultPath
  if (typeof saved === 'string' && saved.trim() !== '') return path.resolve(expandTilde(saved))
  return config.defaultVaultPath
})()

let activeSource: VaultSource = (() => {
  if (typeof readPersisted().vaultPath === 'string') return 'user'
  return process.env.MYBRAIN_VAULT_PATH ? 'env' : 'default'
})()

export function getVaultPath(): string {
  return activeVaultPath
}
export function getVaultSource(): VaultSource {
  return activeSource
}

export interface VaultPaths {
  root: string
  claudeDir: string
  nightlyLog: string
  odooScript: string
  ghlSkillDir: string
  prompts: {
    weeklyDigest: string
    inboxClassify: string
    nightlyConsolidation: string
    ghlSyncColma: string
    ghlSyncUpdUrns: string
  }
}

/** All vault-derived paths for the CURRENTLY active vault (env overrides honored). */
export function vaultPaths(): VaultPaths {
  const root = activeVaultPath
  const claudeDir = path.join(root, '.claude')
  const envPath = (name: string, fallback: string): string =>
    process.env[name] ? path.resolve(expandTilde(process.env[name]!)) : fallback
  return {
    root,
    claudeDir,
    nightlyLog: path.join(claudeDir, 'nightly.log'),
    odooScript: envPath('ODOO_SCRIPT_PATH', path.join(claudeDir, 'skills', 'odoo-sync', 'odoo_sync.py')),
    ghlSkillDir: path.join(claudeDir, 'skills', 'ghl-sync'),
    prompts: {
      weeklyDigest: envPath('WEEKLY_DIGEST_PROMPT_PATH', path.join(claudeDir, 'prompts', 'weekly-digest.txt')),
      inboxClassify: envPath('INBOX_CLASSIFY_PROMPT_PATH', path.join(claudeDir, 'prompts', 'inbox-classify.txt')),
      nightlyConsolidation: path.join(claudeDir, 'prompts', 'nightly-consolidation.txt'),
      ghlSyncColma: path.join(claudeDir, 'prompts', 'ghl-sync-colma.txt'),
      ghlSyncUpdUrns: path.join(claudeDir, 'prompts', 'ghl-sync-upd-urns.txt'),
    },
  }
}

// ── Inspection / validation ────────────────────────────────────────────────

export interface VaultStatus {
  path: string
  exists: boolean
  isDirectory: boolean
  /** Has markdown and/or Obsidian/Claude config — i.e. plausibly a vault. */
  looksLikeVault: boolean
  hasObsidian: boolean
  hasClaudeDir: boolean
  markdownCount: number
  /** Top-level folders found (helps the user recognize their vault). */
  folders: string[]
  /** Why it can't be used, when applicable. */
  problem?: string
}

/** Counts .md files up to a shallow depth; capped so huge trees stay fast. */
function countMarkdown(dir: string, depth = 2, cap = 25): number {
  if (depth < 0) return 0
  let n = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    if (n >= cap) break
    if (e.name.startsWith('.')) continue
    if (e.isFile() && e.name.toLowerCase().endsWith('.md')) n++
    else if (e.isDirectory()) n += countMarkdown(path.join(dir, e.name), depth - 1, cap - n)
  }
  return n
}

/**
 * Refuses paths that are too broad to be a vault (filesystem root, a top-level
 * dir, or the home dir itself) — pointing the tool at those would put unrelated
 * files in reach of vault reads and the Regenerate write path.
 */
function tooBroad(abs: string): boolean {
  if (abs === path.parse(abs).root) return true
  if (abs === os.homedir()) return true
  const rel = path.relative(path.parse(abs).root, abs)
  return rel.split(path.sep).filter(Boolean).length < 2
}

export function inspectVault(rawPath: string): VaultStatus {
  const abs = path.resolve(expandTilde(rawPath.trim()))
  const base: VaultStatus = {
    path: abs,
    exists: false,
    isDirectory: false,
    looksLikeVault: false,
    hasObsidian: false,
    hasClaudeDir: false,
    markdownCount: 0,
    folders: [],
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(abs)
  } catch {
    return { ...base, problem: 'Path does not exist.' }
  }
  if (!stat.isDirectory()) return { ...base, exists: true, problem: 'Path is not a directory.' }
  if (tooBroad(abs)) {
    return {
      ...base,
      exists: true,
      isDirectory: true,
      problem: 'Path is too broad (filesystem root or home directory). Pick the vault folder itself.',
    }
  }

  const hasObsidian = fs.existsSync(path.join(abs, '.obsidian'))
  const hasClaudeDir = fs.existsSync(path.join(abs, '.claude'))
  let folders: string[] = []
  try {
    folders = fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .slice(0, 12)
  } catch {
    return { ...base, exists: true, isDirectory: true, problem: 'Directory is not readable.' }
  }
  const markdownCount = countMarkdown(abs)
  const looksLikeVault = hasObsidian || markdownCount > 0

  return {
    path: abs,
    exists: true,
    isDirectory: true,
    looksLikeVault,
    hasObsidian,
    hasClaudeDir,
    markdownCount,
    folders,
    problem: looksLikeVault ? undefined : 'No markdown notes or .obsidian folder found here.',
  }
}

export class VaultSettingsError extends Error {
  constructor(
    message: string,
    public readonly status: VaultStatus,
  ) {
    super(message)
    this.name = 'VaultSettingsError'
  }
}

/** Validates, persists and activates a new vault path. Throws with the status on refusal. */
export async function setVaultPath(rawPath: string): Promise<VaultStatus> {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new VaultSettingsError('A vault path is required.', inspectVault('.'))
  }
  const status = inspectVault(rawPath)
  if (status.problem) throw new VaultSettingsError(status.problem, status)

  await fsp.mkdir(config.dataDir, { recursive: true })
  const next: PersistedSettings = { ...readPersisted(), vaultPath: status.path }
  await fsp.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8')
  activeVaultPath = status.path
  activeSource = 'user'
  return status
}

/** Clears the user's choice and falls back to env/default. */
export async function resetVaultPath(): Promise<VaultStatus> {
  const persisted = readPersisted()
  delete persisted.vaultPath
  await fsp.mkdir(config.dataDir, { recursive: true })
  await fsp.writeFile(SETTINGS_FILE, JSON.stringify(persisted, null, 2), 'utf8')
  activeVaultPath = config.defaultVaultPath
  activeSource = process.env.MYBRAIN_VAULT_PATH ? 'env' : 'default'
  return inspectVault(activeVaultPath)
}

/** Scans common locations for folders that look like vaults, to offer as choices. */
export async function detectVaults(): Promise<VaultStatus[]> {
  const home = os.homedir()
  const roots = [
    path.join(home, 'Documents'),
    home,
    path.join(home, 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents'),
  ]
  const found = new Map<string, VaultStatus>()
  for (const root of roots) {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      const abs = path.join(root, e.name)
      if (found.has(abs)) continue
      // Only surface confident candidates: an Obsidian vault or a .claude-configured folder.
      if (!fs.existsSync(path.join(abs, '.obsidian')) && !fs.existsSync(path.join(abs, '.claude'))) continue
      const status = inspectVault(abs)
      if (!status.problem) found.set(abs, status)
      if (found.size >= 10) break
    }
  }
  return [...found.values()]
}
