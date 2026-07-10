import fs from 'node:fs'
import { config } from '../config/index.js'
import { makeClaudeRunDefinition } from './claude.js'
import type { ClaudeActionSpec } from './claude.js'
import type { RunDefinition } from '../services/run-manager.js'

/**
 * The fixed catalog of Claude actions. Every /api/run/* endpoint maps to
 * exactly one spec here — there is no way to run anything not in this file.
 */

/**
 * Verbatim nightly-consolidation prompt. Verified source: the user's crontab
 * entry (23:00 daily), audited on 2026-07-10. Per the PRD (§10) prompts are
 * passed exactly as already validated in the vault — do not paraphrase. If
 * .claude/prompts/nightly-consolidation.txt appears in the vault later, it
 * takes precedence (see PromptSource.overrideFilePath).
 */
const NIGHTLY_CONSOLIDATION_PROMPT_VERBATIM =
  'Read everything I added to my vault today. Find orphan notes and create those files. Consolidate duplicate notes. Update relevant MOCs. Flag anything strategic for review tomorrow.'

/** Fixed, tool-less-by-intent auth probe. Non-destructive: read-only tool allowance, minimal text reply. */
const AUTH_PROBE_PROMPT =
  'Reply with exactly this text and nothing else: AGENTIC-OS AUTH OK. Do not use any tools.'

/** Env var presence checks report NAMES only — values are never read into messages. */
function missingEnv(names: string[]): string[] {
  return names.filter((n) => !process.env[n]).map((n) => `env ${n}`)
}

function missingFile(label: string, filePath: string): string[] {
  return fs.existsSync(filePath) ? [] : [`${label} ${filePath}`]
}

const VAULT_WRITE_TOOLS = 'Read,Write,Bash(git:*)' // PRD §5.2 verbatim

export const CLAUDE_ACTION_SPECS: ClaudeActionSpec[] = [
  {
    kind: 'inbox-classify',
    title: 'Classify Inbox',
    description:
      'Classifies 0_Inbox notes into PARA folders applying the classification + recency-weighting skills.',
    mutexGroup: 'vault-write',
    promptSource: { type: 'file', path: config.prompts.inboxClassifyPath },
    allowedTools: VAULT_WRITE_TOOLS,
    cwd: config.vaultPath,
    timeoutMs: config.timeouts.claudeRunMs,
    checkMissing: () => missingFile('prompt file', config.prompts.inboxClassifyPath),
  },
  {
    kind: 'nightly-consolidation',
    title: 'Nightly Consolidation',
    description: 'Runs the same consolidation prompt the 23:00 cron uses, on demand.',
    mutexGroup: 'vault-write',
    promptSource: {
      type: 'verified-inline',
      text: NIGHTLY_CONSOLIDATION_PROMPT_VERBATIM,
      provenance: 'crontab entry (verbatim, audited 2026-07-10)',
      overrideFilePath: config.prompts.nightlyConsolidationPath,
    },
    allowedTools: VAULT_WRITE_TOOLS,
    cwd: config.vaultPath,
    timeoutMs: config.timeouts.claudeRunMs,
    checkMissing: () => [],
  },
  {
    kind: 'weekly-digest',
    title: 'Weekly Digest',
    description:
      'Generates the UPD Urns weekly digest from read-only Odoo pulls (same prompt as the Monday cron).',
    mutexGroup: 'vault-write',
    promptSource: { type: 'file', path: config.prompts.weeklyDigestPath },
    // Bash is scoped to the odoo-sync script invocation only.
    allowedTools: 'Read,Write,Bash(python3 .claude/skills/odoo-sync/odoo_sync.py:*)',
    cwd: config.vaultPath,
    timeoutMs: config.timeouts.claudeRunMs,
    checkMissing: () => [
      ...missingFile('prompt file', config.prompts.weeklyDigestPath),
      ...missingFile('odoo script', config.odooScriptPath),
      ...missingEnv(['ODOO_URL', 'ODOO_USERNAME', 'ODOO_API_KEY']),
    ],
  },
  {
    kind: 'ghl-sync-colma',
    title: 'GHL Sync — Colma',
    description: 'Read/sync of the Colma GHL pipeline into the vault (never writes to GHL).',
    mutexGroup: 'vault-write',
    promptSource: { type: 'file', path: config.prompts.ghlSyncColmaPath },
    // Placeholder scope — revisit when the ghl-sync skill lands in the vault.
    allowedTools: 'Read,Write',
    cwd: config.vaultPath,
    timeoutMs: config.timeouts.claudeRunMs,
    checkMissing: () => [
      ...missingFile('skill', config.ghlSyncSkillDir),
      ...missingFile('prompt file', config.prompts.ghlSyncColmaPath),
      ...missingEnv(['GHL_API_TOKEN', 'GHL_LOCATION_ID']),
    ],
  },
  {
    kind: 'ghl-sync-upd-urns',
    title: 'GHL Sync — UPD Urns',
    description: 'Read/sync of the UPD Urns GHL pipeline into the vault (never writes to GHL).',
    mutexGroup: 'vault-write',
    promptSource: { type: 'file', path: config.prompts.ghlSyncUpdUrnsPath },
    allowedTools: 'Read,Write',
    cwd: config.vaultPath,
    timeoutMs: config.timeouts.claudeRunMs,
    checkMissing: () => [
      ...missingFile('skill', config.ghlSyncSkillDir),
      ...missingFile('prompt file', config.prompts.ghlSyncUpdUrnsPath),
      ...missingEnv(['GHL_API_TOKEN', 'GHL_LOCATION_ID']),
    ],
  },
  {
    kind: 'auth-probe',
    title: 'Claude Auth Probe',
    description:
      'Non-destructive CLI/auth check: asks for a fixed one-line reply, read-only tool allowance, no vault writes.',
    mutexGroup: 'diagnostics',
    promptSource: {
      type: 'verified-inline',
      text: AUTH_PROBE_PROMPT,
      provenance: 'fixed diagnostic prompt (backend source)',
    },
    allowedTools: 'Read',
    cwd: config.vaultPath,
    timeoutMs: 120_000,
    checkMissing: () => [],
  },
]

export const CLAUDE_RUN_DEFINITIONS: Record<string, RunDefinition> = Object.fromEntries(
  CLAUDE_ACTION_SPECS.map((spec) => [spec.kind, makeClaudeRunDefinition(spec)]),
)
