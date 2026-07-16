import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config/index.js'
import { redactSecrets } from '../utils/redact.js'
import { sanitizedClaudeEnv } from '../runners/claude.js'
import { resolveVaultDoc } from './knowledge.js'
import { getVaultPath } from './vault-settings.js'

/**
 * Regenerate (PRD Pattern B) — safe two-phase note refresh:
 *
 *   preview: `claude -p` (READ-ONLY, allowedTools=Read) reads the note and
 *            emits a proposed new version to stdout. Nothing is written.
 *   apply:   after the user confirms the exact diff, the backend writes the
 *            approved bytes to the vault note and backs up the previous
 *            version (gitignored). Never a silent overwrite.
 *
 * The generation goes through Claude (PRD); the overwrite writes exactly the
 * user-approved content (vault rule 9 — approve the precise content), which a
 * second non-deterministic Claude write could not guarantee.
 */

const PREVIEW_TIMEOUT_MS = 180_000
const MIN_APPROVED_BYTES = 20

export class RegenerateError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_FOUND' | 'CLI_FAILED' | 'BAD_CONTENT' = 'CLI_FAILED',
  ) {
    super(message)
    this.name = 'RegenerateError'
  }
}

function regeneratePrompt(relPath: string): string {
  return (
    `Read the note at "${relPath}" in this vault. Produce a refreshed, cleaner version of it: ` +
    `preserve its YAML frontmatter (title, created, tags, status) exactly, keep every real fact, ` +
    `improve structure and clarity, and never invent information. ` +
    `Output ONLY the complete new markdown for the note — no commentary, no code fences, no explanation. ` +
    `Do not use any write tools.`
  )
}

interface ClaudeResult {
  code: number | null
  stdout: string
  stderr: string
}

function runClaudeReadOnly(prompt: string): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      config.claudeBin,
      ['-p', prompt, '--output-format', 'text', '--allowedTools', 'Read'],
      { cwd: getVaultPath(), env: sanitizedClaudeEnv(), stdio: ['ignore', 'pipe', 'pipe'], shell: false },
    )
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.stderr.on('data', (c: Buffer) => err.push(c))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new RegenerateError('Regenerate preview timed out'))
    }, PREVIEW_TIMEOUT_MS)
    timer.unref()
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new RegenerateError(`failed to launch claude: ${redactSecrets(e.message)}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
  })
}

export interface RegeneratePreview {
  id: string
  path: string
  current: string
  proposed: string
  generatedBy: string
}

export async function regeneratePreview(id: string): Promise<RegeneratePreview> {
  const resolved = resolveVaultDoc(id)
  if (!resolved) throw new RegenerateError('Unknown or invalid vault note', 'NOT_FOUND')

  let current: string
  try {
    current = await fsp.readFile(resolved.absPath, 'utf8')
  } catch {
    throw new RegenerateError('Vault note not found on disk', 'NOT_FOUND')
  }

  const result = await runClaudeReadOnly(regeneratePrompt(resolved.relPath))
  if (result.code !== 0) {
    const detail = redactSecrets((result.stderr || result.stdout).trim()) || `exit ${String(result.code)}`
    throw new RegenerateError(`Claude CLI failed: ${detail}`, 'CLI_FAILED')
  }
  const proposed = redactSecrets(result.stdout).trim()
  if (proposed.length < MIN_APPROVED_BYTES) {
    throw new RegenerateError('Claude returned empty/too-short content; not offering it as a preview', 'CLI_FAILED')
  }
  return {
    id,
    path: resolved.relPath,
    current,
    proposed: `${proposed}\n`,
    generatedBy: 'claude -p (read-only, allowedTools=Read)',
  }
}

export interface RegenerateApplyResult {
  path: string
  bytesWritten: number
  backupFile: string
}

/**
 * Writes the user-approved content to the vault note. Backs up the previous
 * version to a gitignored dir first (reversible). The caller (UI) guarantees
 * this ran only after an explicit confirm of the exact diff.
 */
export async function regenerateApply(id: string, approvedContent: string): Promise<RegenerateApplyResult> {
  const resolved = resolveVaultDoc(id)
  if (!resolved) throw new RegenerateError('Unknown or invalid vault note', 'NOT_FOUND')
  if (typeof approvedContent !== 'string' || approvedContent.trim().length < MIN_APPROVED_BYTES) {
    throw new RegenerateError('Approved content is empty or too short — refusing to overwrite', 'BAD_CONTENT')
  }

  let previous: string
  try {
    previous = await fsp.readFile(resolved.absPath, 'utf8')
  } catch {
    throw new RegenerateError('Vault note not found on disk', 'NOT_FOUND')
  }

  const backupDir = path.join(config.knowledge.exportDir, '..', 'regenerate-backups')
  await fsp.mkdir(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupFile = path.join(backupDir, `${stamp}-${resolved.relPath.replace(/[\\/]/g, '__')}`)
  await fsp.writeFile(backupFile, previous, 'utf8')

  await fsp.writeFile(resolved.absPath, approvedContent, 'utf8')
  return { path: resolved.relPath, bytesWritten: Buffer.byteLength(approvedContent), backupFile }
}
