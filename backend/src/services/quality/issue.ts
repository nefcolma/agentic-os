/**
 * Data Quality issue contract. Every issue carries the eleven review fields:
 *   tipo→issueType/category · severidad→severity · estado→status ·
 *   confianza→confidence · fuente→source · fecha→detectedAt/sourceDate ·
 *   evidencia→evidence · impacto→businessImpact · métricas→affectedMetrics ·
 *   responsable→proposedOwner · recomendación→recommendedAction.
 *
 * Safety: the Quality Center only DETECTS and RECOMMENDS. It never merges,
 * deletes, reconciles, or adjusts anything in Odoo. Any correction that would
 * require an Odoo write is flagged `correctionRequiresWrite` and would need
 * explicit confirmation through a separate, approved path.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low'
export type IssueStatus = 'open'

export interface QualityEvidence {
  summary: string
  /** A few sample record identifiers/labels — never full datasets, never secrets. */
  samples: string[]
}

export interface QualitySource {
  type: string
  /** 'live' for direct Odoo reads, 'snapshot' for the baked knowledge snapshot. */
  dataFreshness: 'live' | 'snapshot'
  pulledAt: string
}

export interface QualityIssue {
  issueId: string
  issueType: string
  category: string
  title: string
  description: string
  severity: Severity
  status: IssueStatus
  confidence: number
  company: string
  source: QualitySource
  detectedAt: string
  sourceDate: string | null
  affectedModels: string[]
  affectedRecordCount: number | null
  evidence: QualityEvidence
  businessImpact: string
  affectedMetrics: string[]
  proposedOwner: string | null
  recommendedAction: string
  correctionRequiresWrite: boolean
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 }

export function sortIssues(issues: QualityIssue[]): QualityIssue[] {
  return [...issues].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.confidence - a.confidence,
  )
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)

export interface MakeIssueInput {
  issueType: string
  category: string
  title: string
  description: string
  severity: Severity
  confidence: number
  source: QualitySource
  sourceDate?: string | null
  affectedModels?: string[]
  affectedRecordCount?: number | null
  evidence: QualityEvidence
  businessImpact: string
  affectedMetrics: string[]
  proposedOwner?: string | null
  recommendedAction: string
  correctionRequiresWrite?: boolean
  company?: string
}

export function makeIssue(input: MakeIssueInput): QualityIssue {
  return {
    issueId: `dq-${slug(input.issueType)}-${slug(input.title)}`,
    issueType: input.issueType,
    category: input.category,
    title: input.title,
    description: input.description,
    severity: input.severity,
    status: 'open',
    confidence: input.confidence,
    company: input.company ?? 'UPD Urns',
    source: input.source,
    detectedAt: new Date().toISOString(),
    sourceDate: input.sourceDate ?? null,
    affectedModels: input.affectedModels ?? [],
    affectedRecordCount: input.affectedRecordCount ?? null,
    evidence: input.evidence,
    businessImpact: input.businessImpact,
    affectedMetrics: input.affectedMetrics,
    proposedOwner: input.proposedOwner ?? null,
    recommendedAction: input.recommendedAction,
    correctionRequiresWrite: input.correctionRequiresWrite ?? false,
  }
}
