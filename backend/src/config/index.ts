import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SERVICE_NAME = 'agentic-os-backend'
export const SERVICE_VERSION = '0.1.0'

/**
 * Security invariant: the backend must never be reachable from the network.
 * Anything that is not a loopback address is rejected at startup.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export interface AppConfig {
  host: string
  port: number
  /**
   * Fallback vault path used only when the user has not connected one yet.
   * The ACTIVE vault is runtime state — always read it through
   * `services/vault-settings.ts` (getVaultPath / vaultPaths), never from here,
   * so the user can point the dashboard at their own vault without a restart.
   */
  defaultVaultPath: string
  /** Claude Code CLI binary; spawned processes use cwd = the active vault. */
  claudeBin: string
  /** python3 binary used to invoke the read-only Odoo script directly. */
  pythonBin: string
  /** Local, gitignored dir for snapshots, exports, backups and settings.json. */
  dataDir: string
  knowledge: {
    /** Local, gitignored snapshot of the shared Drive knowledge base (agent-baked). */
    snapshotPath: string
    /** Where on-demand "baked" export bundles are written (gitignored). */
    exportDir: string
    /** Shared Drive folder the snapshot is extracted from (read-only). */
    driveFolderId: string
  }
  timeouts: {
    claudeRunMs: number
    odooMs: number
  }
  logs: {
    maxRunLogBytes: number
    lastLogDefaultLines: number
  }
  runs: {
    /** Finished runs kept in memory (active runs are never pruned). */
    maxRetained: number
    /** Grace period between SIGTERM and SIGKILL. */
    killGraceMs: number
    /** SSE keep-alive comment interval. */
    sseHeartbeatMs: number
  }
}

/**
 * Minimal .env loader (root of the repo). Existing process env always wins,
 * so credentials inherited from ~/.zshenv are never overridden by .env.
 */
function loadDotEnv(filePath: string): void {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return // .env is optional
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
    if (!match) continue
    const key = match[1]
    let value = match[2] ?? ''
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    if (key !== undefined && !(key in process.env)) {
      process.env[key] = value
    }
  }
}

function expandTilde(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number.parseInt(raw, 10)
  if (Number.isNaN(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; got "${raw}"`)
  }
  return value
}

function buildConfig(): AppConfig {
  // backend/src/config/ and backend/dist/config/ are both three levels
  // below the repo root, so this resolves correctly in dev and after build.
  loadDotEnv(fileURLToPath(new URL('../../../.env', import.meta.url)))

  const host = (process.env.HOST ?? '127.0.0.1').trim()
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `HOST must be a loopback address (127.0.0.1, localhost or ::1); got "${host}". ` +
        'This dashboard is local-only by design and must never listen on the network.',
    )
  }

  // Only a FALLBACK: the active vault is runtime state (vault-settings.ts).
  const defaultVaultPath = path.resolve(
    expandTilde(process.env.MYBRAIN_VAULT_PATH ?? path.join(os.homedir(), 'Documents', 'MyBrain')),
  )
  const dataDir = path.resolve(fileURLToPath(new URL('../../data', import.meta.url)))

  return {
    host,
    // Named BACKEND_PORT (not PORT) on purpose: dev tooling injects a generic
    // PORT for the frontend dev server, which must not hijack the backend bind.
    port: intFromEnv('BACKEND_PORT', 8790, 1, 65535),
    defaultVaultPath,
    claudeBin: (process.env.CLAUDE_BIN ?? 'claude').trim(),
    pythonBin: (process.env.PYTHON_BIN ?? 'python3').trim(),
    dataDir,
    knowledge: {
      snapshotPath: path.resolve(
        expandTilde(
          process.env.KNOWLEDGE_SNAPSHOT_PATH ??
            fileURLToPath(new URL('../../data/knowledge-snapshot.json', import.meta.url)),
        ),
      ),
      exportDir: path.resolve(
        expandTilde(
          process.env.KNOWLEDGE_EXPORT_DIR ??
            fileURLToPath(new URL('../../data/exports', import.meta.url)),
        ),
      ),
      driveFolderId: (process.env.DRIVE_FOLDER_ID ?? '1qjGOwd5VRkCfaR2MfESUGqmHKFGEYv2b').trim(),
    },
    timeouts: {
      claudeRunMs: intFromEnv('CLAUDE_RUN_TIMEOUT_MS', 900_000, 1_000, 3_600_000),
      odooMs: intFromEnv('ODOO_TIMEOUT_MS', 60_000, 1_000, 600_000),
    },
    logs: {
      maxRunLogBytes: intFromEnv('MAX_RUN_LOG_BYTES', 1_048_576, 1_024, 104_857_600),
      lastLogDefaultLines: intFromEnv('LAST_LOG_DEFAULT_LINES', 200, 1, 5_000),
    },
    runs: {
      maxRetained: intFromEnv('MAX_RUNS_RETAINED', 50, 1, 1_000),
      killGraceMs: 5_000,
      sseHeartbeatMs: 15_000,
    },
  }
}

export const config: AppConfig = buildConfig()
