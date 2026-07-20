// System Map — evidence-honest wiring of Applications / Skills / Routines / Memory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Scratch vault + snapshot path, wired through env BEFORE config is imported.
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmap-vault-'))
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmap-data-'))
const SNAPSHOT = path.join(DATA, 'knowledge-snapshot.json')
fs.mkdirSync(path.join(VAULT, '1_Projects'), { recursive: true })
fs.writeFileSync(path.join(VAULT, '1_Projects', 'a.md'), '# note\n')
process.env.MYBRAIN_VAULT_PATH = VAULT
process.env.KNOWLEDGE_SNAPSHOT_PATH = SNAPSHOT
// Start from a clean, known credential state.
delete process.env.ODOO_URL
delete process.env.ODOO_USERNAME
delete process.env.ODOO_API_KEY

const DIST = new URL('../dist/', import.meta.url).pathname
const { buildSystemMap } = await import(`${DIST}services/system-map.js`)

const byId = (map, id) => map.nodes.find((n) => n.id === id)
const edge = (map, id) => map.edges.find((e) => e.id === id)

test('models the four pillar node types with matching counts', () => {
  const map = buildSystemMap()
  const types = new Set(map.nodes.map((n) => n.type))
  for (const t of ['application', 'skill', 'routine', 'memory']) {
    assert.ok(types.has(t), `missing node type ${t}`)
    assert.equal(
      map.counts[t],
      map.nodes.filter((n) => n.type === t).length,
      `counts.${t} must match the node list`,
    )
  }
  assert.ok(typeof map.generatedAt === 'string' && map.generatedAt.length > 0)
})

test('contains the three minimum chains (Odoo, Drive, Vault)', () => {
  const map = buildSystemMap()
  // Odoo → odoo-sync → Weekly Digest → Weekly Digest Memory Note
  assert.ok(edge(map, 'edge:odoo-sync-reads-odoo'))
  assert.ok(edge(map, 'edge:weekly-digest-uses-odoo-sync'))
  assert.ok(edge(map, 'edge:weekly-digest-writes-note'))
  // Google Drive → Drive Snapshot Routine → Knowledge Snapshot
  assert.ok(edge(map, 'edge:drive-snapshot-reads-drive'))
  assert.ok(edge(map, 'edge:drive-snapshot-generates-snapshot'))
  // Vault → Nightly Consolidation → MOCs
  assert.ok(edge(map, 'edge:nightly-reads-vault'))
  assert.ok(edge(map, 'edge:nightly-updates-mocs'))
})

test('every edge references existing nodes and carries evidence', () => {
  const map = buildSystemMap()
  const ids = new Set(map.nodes.map((n) => n.id))
  for (const e of map.edges) {
    assert.ok(ids.has(e.source), `edge ${e.id} has unknown source ${e.source}`)
    assert.ok(ids.has(e.target), `edge ${e.id} has unknown target ${e.target}`)
    assert.ok(Array.isArray(e.evidence) && e.evidence.length > 0, `edge ${e.id} must carry evidence`)
    assert.ok(['verified', 'declared', 'unresolved'].includes(e.verification))
  }
})

test('Odoo: not_configured + declared without credentials; verified once script and env exist', () => {
  let map = buildSystemMap()
  assert.equal(byId(map, 'app:odoo').status, 'not_configured')
  assert.equal(edge(map, 'edge:odoo-sync-reads-odoo').verification, 'declared')

  // Configure: create the odoo-sync script in the vault and set env presence.
  const scriptPath = path.join(VAULT, '.claude', 'skills', 'odoo-sync', 'odoo_sync.py')
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
  fs.writeFileSync(scriptPath, '# read-only bridge\n')
  process.env.ODOO_URL = 'https://example.invalid'
  process.env.ODOO_USERNAME = 'tester'
  process.env.ODOO_API_KEY = 'sysmap-secret-sentinel-value'

  map = buildSystemMap()
  assert.equal(byId(map, 'app:odoo').status, 'active')
  assert.equal(byId(map, 'skill:odoo-sync').status, 'available')
  assert.equal(edge(map, 'edge:odoo-sync-reads-odoo').verification, 'verified')
  assert.equal(edge(map, 'edge:weekly-digest-uses-odoo-sync').verification, 'verified')
})

test('never leaks secret values — only requirement NAMES appear', () => {
  process.env.ODOO_API_KEY = 'sysmap-secret-sentinel-value'
  process.env.GHL_API_TOKEN = 'ghl-secret-sentinel'
  const json = JSON.stringify(buildSystemMap())
  assert.ok(!json.includes('sysmap-secret-sentinel-value'), 'ODOO_API_KEY value leaked')
  assert.ok(!json.includes('ghl-secret-sentinel'), 'GHL_API_TOKEN value leaked')
  // Names may appear (that is the point of presence reporting).
  assert.ok(json.includes('ODOO_API_KEY'))
})

test('knowledge snapshot: missing → stale → available, with the shared threshold', () => {
  fs.rmSync(SNAPSHOT, { force: true })
  let map = buildSystemMap()
  assert.equal(byId(map, 'memory:knowledge-snapshot').status, 'missing')
  assert.equal(edge(map, 'edge:drive-snapshot-generates-snapshot').verification, 'declared')

  const old = new Date(Date.now() - 30 * 86_400_000).toISOString()
  fs.writeFileSync(SNAPSHOT, JSON.stringify({ generatedAt: old, generatedBy: 'test' }))
  map = buildSystemMap()
  assert.equal(byId(map, 'memory:knowledge-snapshot').status, 'stale')
  assert.equal(edge(map, 'edge:drive-snapshot-generates-snapshot').verification, 'verified')

  fs.writeFileSync(SNAPSHOT, JSON.stringify({ generatedAt: new Date().toISOString(), generatedBy: 'test' }))
  map = buildSystemMap()
  assert.equal(byId(map, 'memory:knowledge-snapshot').status, 'available')
})

test('drive snapshot routine is manual — never presented as an active automation', () => {
  const map = buildSystemMap()
  assert.equal(byId(map, 'routine:drive-snapshot').status, 'manual')
  assert.equal(edge(map, 'edge:drive-snapshot-reads-drive').verification, 'declared')
})

test('weekly digest memory note stays unresolved without a declared output path', () => {
  const map = buildSystemMap()
  const e = edge(map, 'edge:weekly-digest-writes-note')
  assert.equal(e.verification, 'unresolved')
  assert.ok(e.evidence.some((ev) => /output path/i.test(ev.detail)))
  assert.ok(map.warnings.some((w) => /output path/i.test(w)))
})

test('nightly consolidation distinguishes declared schedule from execution evidence', () => {
  // No nightly.log yet → available (not active), with a warning.
  const logPath = path.join(VAULT, '.claude', 'nightly.log')
  fs.rmSync(logPath, { force: true })
  let map = buildSystemMap()
  assert.equal(byId(map, 'routine:nightly-consolidation').status, 'available')
  assert.ok(map.warnings.some((w) => /nightly\.log/i.test(w)))

  // Fresh log evidence → active. MOCs found → updates edge verified.
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.writeFileSync(logPath, 'consolidation ran\n')
  fs.writeFileSync(path.join(VAULT, 'Projects MOC.md'), '# moc\n')
  map = buildSystemMap()
  assert.equal(byId(map, 'routine:nightly-consolidation').status, 'active')
  assert.equal(byId(map, 'memory:mocs').status, 'available')
  assert.equal(edge(map, 'edge:nightly-updates-mocs').verification, 'verified')
})
