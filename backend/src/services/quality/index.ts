import fs from 'node:fs'
import { config } from '../../config/index.js'
import {
  getInventory,
  getTopClients,
  getDecliningClients,
  getOverdueInvoices,
  odooMissingRequirements,
} from '../../runners/odoo.js'
import type { QualitySource } from './issue.js'
import { makeIssue, sortIssues } from './issue.js'
import type { QualityIssue, Severity } from './issue.js'
import {
  detectNegativeInventory,
  detectMissingIdentifiers,
  detectDuplicateCustomers,
  detectLowResidualOverdue,
  detectIncompleteCustomers,
} from './detectors.js'

export interface QualityScan {
  status: 'ok' | 'not_configured' | 'error'
  generatedAt: string
  scanned: string[]
  counts: { total: number; critical: number; high: number; medium: number; low: number }
  issues: QualityIssue[]
  missing?: string[]
  message?: string
}

/** Shared staleness threshold — the System Map reuses this same limit. */
export const STALE_SNAPSHOT_DAYS = 7

/** Flags the local knowledge snapshot as stale — the one detector over snapshot data. */
function detectStaleSnapshot(): QualityIssue[] {
  let raw: string
  try {
    raw = fs.readFileSync(config.knowledge.snapshotPath, 'utf8')
  } catch {
    return []
  }
  let generatedAt: string | null = null
  try {
    generatedAt = (JSON.parse(raw) as { generatedAt?: string }).generatedAt ?? null
  } catch {
    return []
  }
  if (!generatedAt) return []
  const ageDays = (Date.now() - new Date(generatedAt).getTime()) / 86_400_000
  if (ageDays < STALE_SNAPSHOT_DAYS) return []
  const source: QualitySource = { type: 'knowledge_snapshot', dataFreshness: 'snapshot', pulledAt: generatedAt }
  return [
    makeIssue({
      issueType: 'STALE_DATA_SOURCE',
      category: 'Data freshness',
      title: `Knowledge snapshot is ${Math.floor(ageDays)} days old`,
      description: `The local Drive knowledge snapshot was last baked ${Math.floor(
        ageDays,
      )} days ago (${generatedAt.slice(0, 10)}). Snapshot-based answers and the knowledge viewer will drift from the live Drive folder until it is re-baked.`,
      severity: 'medium',
      confidence: 0.95,
      source,
      sourceDate: generatedAt,
      affectedRecordCount: null,
      evidence: {
        summary: `Snapshot generatedAt=${generatedAt}, threshold=${STALE_SNAPSHOT_DAYS}d.`,
        samples: [config.knowledge.snapshotPath],
      },
      businessImpact: 'Viewer and snapshot-based context silently age away from operational reality.',
      affectedMetrics: ['Knowledge freshness'],
      proposedOwner: null,
      recommendedAction: 'Ask Claude to re-bake the Drive snapshot (read-only extraction).',
      correctionRequiresWrite: false,
      company: 'UPD Urns / Colma',
    }),
  ]
}

export async function runQualityScan(): Promise<QualityScan> {
  const generatedAt = new Date().toISOString()
  const snapshotIssues = detectStaleSnapshot()

  const missing = odooMissingRequirements()
  if (missing.length > 0) {
    // Odoo detectors can't run, but a stale-snapshot finding may still exist.
    return finalize('not_configured', generatedAt, ['knowledge-snapshot'], snapshotIssues, {
      missing,
      message: 'Odoo is not configured — customer/inventory/AR detectors are unavailable.',
    })
  }

  try {
    const [inv, top, declining, overdue] = await Promise.all([
      getInventory({ limit: '500' }),
      getTopClients({ days: '90', limit: '50' }),
      getDecliningClients({ days: '90', minOrders: '2', limit: '50' }),
      getOverdueInvoices({ limit: '200' }),
    ])

    const src = (pulledAt: string): QualitySource => ({ type: 'odoo', dataFreshness: 'live', pulledAt })
    const issues: QualityIssue[] = [
      ...snapshotIssues,
      ...detectNegativeInventory(inv.rows, src(inv.pulledAt)),
      ...detectMissingIdentifiers(inv.rows, src(inv.pulledAt)),
      ...detectDuplicateCustomers(top.rows, declining.rows, src(top.pulledAt)),
      ...detectLowResidualOverdue(overdue.rows, src(overdue.pulledAt)),
      ...detectIncompleteCustomers(overdue.rows, src(overdue.pulledAt)),
    ]
    return finalize('ok', generatedAt, ['inventory', 'top-clients', 'declining-clients', 'overdue-invoices', 'knowledge-snapshot'], issues)
  } catch (err) {
    return finalize('error', generatedAt, ['knowledge-snapshot'], snapshotIssues, {
      message: err instanceof Error ? err.message : 'Odoo scan failed',
    })
  }
}

function finalize(
  status: QualityScan['status'],
  generatedAt: string,
  scanned: string[],
  issues: QualityIssue[],
  extra: { missing?: string[]; message?: string } = {},
): QualityScan {
  const sorted = sortIssues(issues)
  const bySeverity = (s: Severity): number => sorted.filter((i) => i.severity === s).length
  return {
    status,
    generatedAt,
    scanned,
    counts: {
      total: sorted.length,
      critical: bySeverity('critical'),
      high: bySeverity('high'),
      medium: bySeverity('medium'),
      low: bySeverity('low'),
    },
    issues: sorted,
    ...extra,
  }
}
