import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config/index.js'
import { CLAUDE_ACTION_SPECS } from '../runners/claude-actions.js'
import type { ClaudeActionSpec, PromptSource } from '../runners/claude.js'
import { getVaultPath, inspectVault, vaultPaths } from './vault-settings.js'
import { STALE_SNAPSHOT_DAYS } from './quality/index.js'

/**
 * SystemMapService — a read-only, typed explanation of how the agentic OS is
 * wired: which Applications feed which Skills, which Routines use them, and
 * which Memory they consume or produce.
 *
 * Invariants (mirrors the honesty rules of Data Quality):
 *  - Nothing is executed. No Claude, no routines, no network. Filesystem is
 *    only consulted through existsSync/statSync/readFileSync on paths that
 *    the backend already owns (vaultPaths(), config.knowledge).
 *  - A relationship is `verified` ONLY when concrete evidence exists in
 *    CLAUDE_ACTION_SPECS, run definitions, backend config, allowedTools
 *    scopes, prompts, the knowledge snapshot, or the filesystem. Anything
 *    merely plausible is `declared` or `unresolved`, with the missing
 *    evidence spelled out — connections are never invented.
 *  - Secrets never appear: env checks report NAMES only (reusing each spec's
 *    checkMissing), and no env VALUE is ever read into the response.
 *  - The catalog is DERIVED from CLAUDE_ACTION_SPECS + config instead of
 *    being a second hand-maintained list, so it cannot silently drift.
 */

// ── Shared types (mirrored in frontend/src/lib/types.ts) ──────────────────

export type SystemNodeType = 'application' | 'routine' | 'memory' | 'skill'

export type SystemNodeStatus =
  | 'active'
  | 'available'
  | 'manual'
  | 'not_configured'
  | 'missing'
  | 'stale'
  | 'disabled'

export type SystemVerificationStatus = 'verified' | 'declared' | 'unresolved'

export interface SystemNode {
  id: string
  type: SystemNodeType
  label: string
  description: string
  status: SystemNodeStatus
  company?: string
  metadata: Record<string, string | number | boolean | null>
}

export interface SystemEvidence {
  kind: 'run_definition' | 'config' | 'filesystem' | 'prompt' | 'tool_scope' | 'manual_declaration'
  reference: string
  detail: string
}

export interface SystemEdge {
  id: string
  source: string
  target: string
  relationship:
    | 'uses'
    | 'reads_from'
    | 'writes_to'
    | 'generates'
    | 'updates'
    | 'triggered_by'
    | 'depends_on'
  verification: SystemVerificationStatus
  evidence: SystemEvidence[]
}

export interface SystemMapResponse {
  generatedAt: string
  nodes: SystemNode[]
  edges: SystemEdge[]
  counts: Record<SystemNodeType, number>
  warnings: string[]
}

// ── Node ids (single source of truth for edge wiring) ─────────────────────

const ID = {
  odoo: 'app:odoo',
  drive: 'app:google-drive',
  ghl: 'app:gohighlevel',
  odooSync: 'skill:odoo-sync',
  ghlSync: 'skill:ghl-sync',
  weeklyDigest: 'routine:weekly-digest',
  inboxClassify: 'routine:inbox-classify',
  nightly: 'routine:nightly-consolidation',
  driveSnapshotRoutine: 'routine:drive-snapshot',
  ghlColma: 'routine:ghl-sync-colma',
  ghlUpdUrns: 'routine:ghl-sync-upd-urns',
  vault: 'memory:vault',
  snapshot: 'memory:knowledge-snapshot',
  weeklyDigestNote: 'memory:weekly-digest-note',
  mocs: 'memory:mocs',
} as const

// ── Safe filesystem probes ────────────────────────────────────────────────

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

function statMtimeIso(p: string): string | null {
  try {
    return fs.statSync(p).mtime.toISOString()
  } catch {
    return null
  }
}

function ageDays(iso: string | null): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return (Date.now() - t) / 86_400_000
}

/** Reads the knowledge snapshot's own metadata — fresh on every call, never cached. */
function readSnapshotMeta(): { exists: boolean; generatedAt: string | null; generatedBy: string | null } {
  let raw: string
  try {
    raw = fs.readFileSync(config.knowledge.snapshotPath, 'utf8')
  } catch {
    return { exists: false, generatedAt: null, generatedBy: null }
  }
  try {
    const parsed = JSON.parse(raw) as { generatedAt?: string; generatedBy?: string }
    return {
      exists: true,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null,
      generatedBy: typeof parsed.generatedBy === 'string' ? parsed.generatedBy : null,
    }
  } catch {
    return { exists: true, generatedAt: null, generatedBy: null }
  }
}

/**
 * Shallow, capped scan for MOC files / indices inside the vault ("… MOC.md",
 * "MOC - ….md" or a MOCs folder). Depth- and count-limited so a huge vault
 * stays fast, and vault CONTENT is never loaded — only names are matched.
 */
function findMocs(root: string, depth = 2, cap = 10): string[] {
  if (depth < 0 || cap <= 0) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const e of entries) {
    if (found.length >= cap) break
    if (e.name.startsWith('.')) continue
    const abs = path.join(root, e.name)
    if (e.isFile() && /(^|[\s_-])MOCs?([\s_.-]|$)/i.test(e.name) && e.name.toLowerCase().endsWith('.md')) {
      found.push(path.relative(root, abs))
    } else if (e.isDirectory()) {
      if (/^MOCs?$/i.test(e.name)) found.push(`${path.relative(root, abs)}/`)
      found.push(...findMocs(abs, depth - 1, cap - found.length).map((p) => path.join(e.name, p)))
    }
  }
  return found
}

/** Env presence WITHOUT values — mirrors checkMissing's "env NAME" convention. */
function envPresent(names: string[]): { present: boolean; missing: string[] } {
  const missing = names.filter((n) => !process.env[n]).map((n) => `env ${n}`)
  return { present: missing.length === 0, missing }
}

function specByKind(kind: string): ClaudeActionSpec | undefined {
  return CLAUDE_ACTION_SPECS.find((s) => s.kind === kind)
}

function promptEvidence(spec: ClaudeActionSpec): SystemEvidence {
  const source: PromptSource = spec.promptSource()
  if (source.type === 'file') {
    const exists = fileExists(source.path)
    return {
      kind: 'prompt',
      reference: source.path,
      detail: exists ? 'Prompt file present in the vault.' : 'Prompt file is MISSING at this path.',
    }
  }
  return {
    kind: 'prompt',
    reference: source.provenance,
    detail: 'Verbatim prompt shipped with the backend (external provenance audited).',
  }
}

// ── Builder ───────────────────────────────────────────────────────────────

const NIGHTLY_ACTIVE_WINDOW_DAYS = 2

export function buildSystemMap(): SystemMapResponse {
  const generatedAt = new Date().toISOString()
  const warnings: string[] = []
  const nodes: SystemNode[] = []
  const edges: SystemEdge[] = []
  const paths = vaultPaths()
  const vaultStatus = inspectVault(getVaultPath())

  // ── Applications ────────────────────────────────────────────────────────

  const odooEnv = envPresent(['ODOO_URL', 'ODOO_USERNAME', 'ODOO_API_KEY'])
  nodes.push({
    id: ID.odoo,
    type: 'application',
    label: 'Odoo',
    description:
      'ERP for UPD Urns — pulled read-only (search_read only) via the odoo-sync script. The backend never writes to Odoo.',
    status: odooEnv.present ? 'active' : 'not_configured',
    company: 'UPD Urns',
    metadata: {
      credentialsConfigured: odooEnv.present,
      missingRequirements: odooEnv.missing.join(', ') || null,
      accessMode: 'read-only',
    },
  })
  if (!odooEnv.present) warnings.push(`Odoo credentials incomplete: ${odooEnv.missing.join(', ')} (names only).`)

  const driveConfigured = config.knowledge.driveFolderId.trim() !== ''
  nodes.push({
    id: ID.drive,
    type: 'application',
    label: 'Google Drive',
    description:
      'Shared Drive knowledge folder ("obsidianbus"). The backend holds NO Drive credentials — it only serves a locally baked snapshot.',
    status: driveConfigured ? 'available' : 'not_configured',
    metadata: {
      folderIdConfigured: driveConfigured,
      backendHasCredentials: false,
    },
  })

  const ghlEnv = envPresent(['GHL_API_TOKEN', 'GHL_LOCATION_ID'])
  nodes.push({
    id: ID.ghl,
    type: 'application',
    label: 'GoHighLevel',
    description: 'CRM pipelines for Colma and UPD Urns — planned read-only sync into the vault (never writes to GHL).',
    status: ghlEnv.present ? 'available' : 'not_configured',
    metadata: {
      credentialsConfigured: ghlEnv.present,
      missingRequirements: ghlEnv.missing.join(', ') || null,
    },
  })

  // ── Skills ──────────────────────────────────────────────────────────────

  const odooScriptExists = fileExists(paths.odooScript)
  nodes.push({
    id: ID.odooSync,
    type: 'skill',
    label: 'odoo-sync',
    description:
      'Read-only Odoo bridge script (search_read pulls). Invoked directly by the backend and by the Weekly Digest routine via a scoped Bash allowance.',
    status: odooScriptExists ? 'available' : 'missing',
    metadata: { scriptPath: paths.odooScript, scriptPresent: odooScriptExists },
  })
  if (!odooScriptExists) warnings.push(`odoo-sync script not found at ${paths.odooScript}.`)

  const ghlSkillExists = fileExists(paths.ghlSkillDir)
  nodes.push({
    id: ID.ghlSync,
    type: 'skill',
    label: 'ghl-sync',
    description: 'Planned GHL sync skill. The GHL routines currently carry a placeholder tool scope until this skill lands in the vault.',
    status: ghlSkillExists ? 'available' : 'missing',
    metadata: { skillDir: paths.ghlSkillDir, skillPresent: ghlSkillExists },
  })

  // ── Routines (derived from CLAUDE_ACTION_SPECS — no second catalog) ─────

  const weeklySpec = specByKind('weekly-digest')
  const weeklyMissing = weeklySpec ? weeklySpec.checkMissing() : ['spec weekly-digest not found']
  nodes.push({
    id: ID.weeklyDigest,
    type: 'routine',
    label: 'Weekly Digest',
    description: weeklySpec?.description ?? 'Weekly digest routine.',
    status: weeklyMissing.length === 0 ? 'available' : 'not_configured',
    company: 'UPD Urns',
    metadata: {
      kind: 'weekly-digest',
      mutexGroup: weeklySpec?.mutexGroup ?? null,
      allowedTools: weeklySpec?.allowedTools ?? null,
      missingRequirements: weeklyMissing.join(', ') || null,
    },
  })

  const inboxSpec = specByKind('inbox-classify')
  const inboxMissing = inboxSpec ? inboxSpec.checkMissing() : ['spec inbox-classify not found']
  nodes.push({
    id: ID.inboxClassify,
    type: 'routine',
    label: 'Classify Inbox',
    description: inboxSpec?.description ?? 'Inbox classification routine.',
    status: inboxMissing.length === 0 ? 'available' : 'not_configured',
    metadata: {
      kind: 'inbox-classify',
      mutexGroup: inboxSpec?.mutexGroup ?? null,
      allowedTools: inboxSpec?.allowedTools ?? null,
      missingRequirements: inboxMissing.join(', ') || null,
    },
  })

  // Nightly Consolidation: the ACTION being defined does not prove the cron is
  // running. We distinguish: definition available / schedule declared (crontab
  // provenance) / last successful run (nightly.log recency).
  const nightlySpec = specByKind('nightly-consolidation')
  const nightlyLogAt = statMtimeIso(paths.nightlyLog)
  const nightlyLogAge = ageDays(nightlyLogAt)
  const nightlySource = nightlySpec?.promptSource()
  const nightlyProvenance =
    nightlySource && nightlySource.type === 'verified-inline' ? nightlySource.provenance : null
  const nightlyStatus: SystemNodeStatus =
    nightlySpec === undefined
      ? 'missing'
      : nightlyLogAge !== null && nightlyLogAge <= NIGHTLY_ACTIVE_WINDOW_DAYS
        ? 'active'
        : 'available'
  nodes.push({
    id: ID.nightly,
    type: 'routine',
    label: 'Nightly Consolidation',
    description:
      'Vault consolidation prompt (also runnable on demand). "Active" requires recent nightly.log evidence — a declared schedule alone is not proof the cron is running.',
    status: nightlyStatus,
    metadata: {
      kind: 'nightly-consolidation',
      scheduleDeclared: nightlyProvenance,
      lastLogAt: nightlyLogAt,
      lastLogAgeDays: nightlyLogAge === null ? null : Math.round(nightlyLogAge * 10) / 10,
      logPath: paths.nightlyLog,
    },
  })
  if (nightlyLogAt === null) {
    warnings.push('No nightly.log found — the declared 23:00 consolidation schedule has no execution evidence yet.')
  }

  // Drive Snapshot: there is NO run definition for this — regeneration is a
  // manual, agent-driven extraction. It must never be presented as automated.
  nodes.push({
    id: ID.driveSnapshotRoutine,
    type: 'routine',
    label: 'Drive Snapshot Routine',
    description:
      'Manual re-bake of the Drive knowledge snapshot (read-only extraction performed by the agent). No executable run definition exists, so it is never shown as an active automation.',
    status: 'manual',
    metadata: { hasRunDefinition: false, trigger: 'manual (ask the agent to re-bake)' },
  })

  for (const [nodeId, kind, company] of [
    [ID.ghlColma, 'ghl-sync-colma', 'Colma'],
    [ID.ghlUpdUrns, 'ghl-sync-upd-urns', 'UPD Urns'],
  ] as const) {
    const spec = specByKind(kind)
    const missing = spec ? spec.checkMissing() : [`spec ${kind} not found`]
    nodes.push({
      id: nodeId,
      type: 'routine',
      label: spec?.title ?? kind,
      description: spec?.description ?? '',
      status: missing.length === 0 ? 'available' : 'not_configured',
      company,
      metadata: {
        kind,
        mutexGroup: spec?.mutexGroup ?? null,
        allowedTools: spec?.allowedTools ?? null,
        missingRequirements: missing.join(', ') || null,
      },
    })
  }

  // ── Memory ──────────────────────────────────────────────────────────────

  nodes.push({
    id: ID.vault,
    type: 'memory',
    label: 'Vault',
    description: 'The local Obsidian vault — primary long-term memory. All vault-writing routines run with cwd = vault.',
    status: !vaultStatus.exists ? 'missing' : vaultStatus.looksLikeVault ? 'active' : 'not_configured',
    metadata: {
      path: vaultStatus.path,
      markdownCount: vaultStatus.markdownCount,
      hasClaudeDir: vaultStatus.hasClaudeDir,
      problem: vaultStatus.problem ?? null,
    },
  })
  if (vaultStatus.problem) warnings.push(`Vault problem: ${vaultStatus.problem}`)

  const snap = readSnapshotMeta()
  const snapAge = ageDays(snap.generatedAt)
  const snapshotStatus: SystemNodeStatus = !snap.exists
    ? 'missing'
    : snapAge !== null && snapAge >= STALE_SNAPSHOT_DAYS
      ? 'stale'
      : 'available'
  nodes.push({
    id: ID.snapshot,
    type: 'memory',
    label: 'Knowledge Snapshot',
    description:
      'Local, gitignored point-in-time snapshot of the shared Drive folder. Served read-only by the backend; freshness uses the same threshold as Data Quality.',
    status: snapshotStatus,
    metadata: {
      path: config.knowledge.snapshotPath,
      generatedAt: snap.generatedAt,
      generatedBy: snap.generatedBy,
      ageDays: snapAge === null ? null : Math.round(snapAge * 10) / 10,
      staleThresholdDays: STALE_SNAPSHOT_DAYS,
    },
  })
  if (snapshotStatus === 'stale') warnings.push(`Knowledge snapshot is stale (>${STALE_SNAPSHOT_DAYS} days old).`)
  if (snapshotStatus === 'missing') warnings.push('Knowledge snapshot is missing — Drive-backed views will be empty until it is baked.')

  // Weekly Digest output note: NO output path is declared anywhere (spec,
  // config or prompt registry), so the exact note cannot be verified.
  nodes.push({
    id: ID.weeklyDigestNote,
    type: 'memory',
    label: 'Weekly Digest Memory Note',
    description:
      'The note the Weekly Digest writes into the vault. Its exact path is not declared in any spec or config, so this destination cannot be verified — only that the routine holds Write access to the vault.',
    status: 'not_configured',
    metadata: { declaredOutputPath: null, reason: 'no verifiable output path declared' },
  })
  warnings.push('Weekly Digest has no declared output path — its memory destination is unresolved.')

  const mocs = vaultStatus.exists ? findMocs(vaultStatus.path) : []
  nodes.push({
    id: ID.mocs,
    type: 'memory',
    label: 'MOCs',
    description: 'Maps of Content / index notes inside the vault, maintained by Nightly Consolidation.',
    status: mocs.length > 0 ? 'available' : 'missing',
    metadata: {
      found: mocs.length,
      examples: mocs.slice(0, 5).join(', ') || null,
      scan: 'name-only, depth/count capped',
    },
  })

  // ── Edges (evidence-backed; never invented) ─────────────────────────────

  // Chain 1 — Odoo → odoo-sync → Weekly Digest → Weekly Digest Memory Note
  const weeklyTools = weeklySpec?.allowedTools ?? ''
  const weeklyToolScopesScript = weeklyTools.includes('odoo_sync.py')
  edges.push({
    id: 'edge:weekly-digest-uses-odoo-sync',
    source: ID.weeklyDigest,
    target: ID.odooSync,
    relationship: 'uses',
    verification: weeklyToolScopesScript && odooScriptExists ? 'verified' : 'declared',
    evidence: [
      {
        kind: 'run_definition',
        reference: 'CLAUDE_ACTION_SPECS["weekly-digest"]',
        detail: 'The Weekly Digest action is a fixed spec in the backend catalog.',
      },
      {
        kind: 'tool_scope',
        reference: weeklyTools || '(none)',
        detail: weeklyToolScopesScript
          ? 'allowedTools scopes Bash to the odoo-sync script invocation only.'
          : 'allowedTools does NOT reference the odoo-sync script — cannot verify the skill is used.',
      },
      {
        kind: 'filesystem',
        reference: paths.odooScript,
        detail: odooScriptExists ? 'odoo-sync script exists at this path.' : 'odoo-sync script is missing — link is declared only.',
      },
      ...(weeklySpec ? [promptEvidence(weeklySpec)] : []),
    ],
  })

  edges.push({
    id: 'edge:odoo-sync-reads-odoo',
    source: ID.odooSync,
    target: ID.odoo,
    relationship: 'reads_from',
    verification: odooScriptExists && odooEnv.present ? 'verified' : 'declared',
    evidence: [
      {
        kind: 'filesystem',
        reference: paths.odooScript,
        detail: odooScriptExists ? 'Script present (read-only search_read bridge).' : 'Script missing.',
      },
      {
        kind: 'config',
        reference: 'ODOO_URL, ODOO_USERNAME, ODOO_API_KEY',
        detail: odooEnv.present
          ? 'All required Odoo credentials are PRESENT (presence only — values are never exposed).'
          : `Missing: ${odooEnv.missing.join(', ')} — connection is declared, not demonstrable.`,
      },
    ],
  })

  edges.push({
    id: 'edge:weekly-digest-writes-note',
    source: ID.weeklyDigest,
    target: ID.weeklyDigestNote,
    relationship: 'writes_to',
    verification: 'unresolved',
    evidence: [
      {
        kind: 'tool_scope',
        reference: weeklyTools || '(none)',
        detail: 'The routine holds Write access to the vault, so it CAN write a note.',
      },
      {
        kind: 'manual_declaration',
        reference: 'output path',
        detail:
          'No output path is declared in the spec, config or prompt registry — the exact note produced cannot be verified. Declare an explicit output path to resolve this.',
      },
    ],
  })

  // Chain 2 — Google Drive → Drive Snapshot Routine → Knowledge Snapshot
  edges.push({
    id: 'edge:drive-snapshot-reads-drive',
    source: ID.driveSnapshotRoutine,
    target: ID.drive,
    relationship: 'reads_from',
    verification: 'declared',
    evidence: [
      {
        kind: 'config',
        reference: 'knowledge.driveFolderId',
        detail: driveConfigured ? 'A Drive folder id is configured (presence only).' : 'No Drive folder id configured.',
      },
      {
        kind: 'manual_declaration',
        reference: 'agent-driven extraction',
        detail:
          'Extraction is performed manually by the agent; the backend holds no Drive credentials and there is no executable run definition, so this stays declared.',
      },
    ],
  })

  edges.push({
    id: 'edge:drive-snapshot-generates-snapshot',
    source: ID.driveSnapshotRoutine,
    target: ID.snapshot,
    relationship: 'generates',
    verification: snap.exists ? 'verified' : 'declared',
    evidence: [
      {
        kind: 'filesystem',
        reference: config.knowledge.snapshotPath,
        detail: snap.exists
          ? `Snapshot file exists${snap.generatedAt ? ` (generatedAt=${snap.generatedAt}` : ' (no generatedAt'}${snap.generatedBy ? `, generatedBy=${snap.generatedBy})` : ')'}.`
          : 'Snapshot file does not exist — the output has never been produced (or was removed).',
      },
    ],
  })

  // Chain 3 — Vault → Nightly Consolidation → MOCs
  edges.push({
    id: 'edge:nightly-reads-vault',
    source: ID.nightly,
    target: ID.vault,
    relationship: 'reads_from',
    verification: nightlySpec !== undefined && vaultStatus.exists ? 'verified' : 'declared',
    evidence: [
      {
        kind: 'run_definition',
        reference: 'CLAUDE_ACTION_SPECS["nightly-consolidation"]',
        detail:
          nightlySpec !== undefined
            ? 'Fixed action spec exists; cwd is the active vault.'
            : 'Spec not found in the catalog.',
      },
      {
        kind: 'tool_scope',
        reference: nightlySpec?.allowedTools ?? '(none)',
        detail: 'Read/Write (+ scoped git) over the vault working directory.',
      },
      ...(nightlyProvenance
        ? [
            {
              kind: 'prompt' as const,
              reference: nightlyProvenance,
              detail: 'Verbatim consolidation prompt with audited external provenance.',
            },
          ]
        : []),
      {
        kind: 'filesystem',
        reference: paths.nightlyLog,
        detail: nightlyLogAt
          ? `Last nightly.log activity: ${nightlyLogAt}.`
          : 'No nightly.log yet — schedule is declared but has no execution evidence.',
      },
    ],
  })

  edges.push({
    id: 'edge:nightly-updates-mocs',
    source: ID.nightly,
    target: ID.mocs,
    relationship: 'updates',
    verification: mocs.length > 0 && nightlySpec !== undefined ? 'verified' : 'declared',
    evidence: [
      {
        kind: 'prompt',
        reference: nightlyProvenance ?? 'nightly-consolidation prompt',
        detail: 'The consolidation prompt explicitly instructs updating relevant MOCs.',
      },
      {
        kind: 'filesystem',
        reference: vaultStatus.path,
        detail:
          mocs.length > 0
            ? `MOC files/indices found in the vault (e.g. ${mocs.slice(0, 3).join(', ')}).`
            : 'No MOC files or indices found in the vault — the target does not demonstrably exist yet.',
      },
    ],
  })

  // Supporting edges — other operative routines and incomplete integrations.
  edges.push({
    id: 'edge:inbox-classify-writes-vault',
    source: ID.inboxClassify,
    target: ID.vault,
    relationship: 'writes_to',
    verification: inboxMissing.length === 0 && vaultStatus.exists ? 'verified' : 'declared',
    evidence: [
      {
        kind: 'run_definition',
        reference: 'CLAUDE_ACTION_SPECS["inbox-classify"]',
        detail: 'Fixed spec: classifies 0_Inbox notes into PARA folders, cwd = vault.',
      },
      {
        kind: 'tool_scope',
        reference: inboxSpec?.allowedTools ?? '(none)',
        detail: 'Read/Write (+ scoped git) over the vault.',
      },
      ...(inboxSpec ? [promptEvidence(inboxSpec)] : []),
    ],
  })

  edges.push({
    id: 'edge:weekly-digest-depends-vault',
    source: ID.weeklyDigest,
    target: ID.vault,
    relationship: 'writes_to',
    verification: weeklyMissing.length === 0 && vaultStatus.exists ? 'verified' : 'declared',
    evidence: [
      {
        kind: 'run_definition',
        reference: 'CLAUDE_ACTION_SPECS["weekly-digest"]',
        detail: 'cwd = vault with Write access — the digest is written into the vault (exact note unresolved, see the memory-note edge).',
      },
    ],
  })

  for (const [edgeId, routineId, kind] of [
    ['edge:ghl-colma-reads-ghl', ID.ghlColma, 'ghl-sync-colma'],
    ['edge:ghl-upd-urns-reads-ghl', ID.ghlUpdUrns, 'ghl-sync-upd-urns'],
  ] as const) {
    const spec = specByKind(kind)
    edges.push({
      id: edgeId,
      source: routineId,
      target: ID.ghl,
      relationship: 'reads_from',
      // Even fully configured this stays declared: the current tool scope is a
      // placeholder (Read,Write) with no GHL-specific scope, so an actual GHL
      // connection cannot be demonstrated from the spec.
      verification: 'declared',
      evidence: [
        {
          kind: 'tool_scope',
          reference: spec?.allowedTools ?? '(none)',
          detail: 'Placeholder scope — no GHL-specific tool allowance yet, so the connection cannot be verified.',
        },
        {
          kind: 'filesystem',
          reference: paths.ghlSkillDir,
          detail: ghlSkillExists ? 'ghl-sync skill directory exists.' : 'ghl-sync skill directory is missing.',
        },
        {
          kind: 'config',
          reference: 'GHL_API_TOKEN, GHL_LOCATION_ID',
          detail: ghlEnv.present ? 'Credentials present (presence only).' : `Missing: ${ghlEnv.missing.join(', ')}.`,
        },
      ],
    })
    edges.push({
      id: `${edgeId}-uses-skill`,
      source: routineId,
      target: ID.ghlSync,
      relationship: 'uses',
      verification: ghlSkillExists ? 'verified' : 'declared',
      evidence: [
        {
          kind: 'filesystem',
          reference: paths.ghlSkillDir,
          detail: ghlSkillExists ? 'Skill directory exists in the vault.' : 'Skill directory not found — dependency is declared only.',
        },
      ],
    })
  }

  // ── Integrity: no edge may point at a node that does not exist ──────────
  const nodeIds = new Set(nodes.map((n) => n.id))
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new Error(`system-map integrity violation: edge ${edge.id} references a missing node`)
    }
  }

  const counts: Record<SystemNodeType, number> = { application: 0, routine: 0, memory: 0, skill: 0 }
  for (const n of nodes) counts[n.type] += 1

  return { generatedAt, nodes, edges, counts, warnings }
}
