// API response shapes — mirror the backend route/service types.

export interface HealthResponse {
  status: 'ok'
  service: string
  version: string
  timestamp: string
  uptimeSeconds: number
  vault: {
    path: string
    exists: boolean
  }
}

export interface NoteSummary {
  file: string
  title: string
  created: string | null
  tags: string[]
  status: string | null
  modifiedAt: string
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

export interface LastLogResponse {
  available: boolean
  path: string
  reason?: 'not_found'
  message?: string
  sizeBytes?: number
  modifiedAt?: string
  lineCount?: number
  truncated?: boolean
  lines?: string[]
}

// ── Runs (RunManager) ────────────────────────────────────────────────────

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface RunInfo {
  id: string
  kind: string
  title: string
  status: RunStatus
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  cancelRequested: boolean
  error: string | null
  logBytes: number
  logTruncatedHead: boolean
}

export interface RunLogLine {
  seq: number
  stream: 'stdout' | 'stderr' | 'system'
  text: string
  at: string
}

export interface RunsListResponse {
  runs: RunInfo[]
}

export interface StartRunResponse {
  run: RunInfo
}

// ── Actions catalog ──────────────────────────────────────────────────────

export interface ActionStatus {
  kind: string
  title: string
  description: string
  group: string
  configured: boolean
  /** Missing requirement labels: file paths / env var NAMES — never values. */
  missing: string[]
}

export interface ActionsResponse {
  actions: ActionStatus[]
}

// ── Odoo (read-only) ─────────────────────────────────────────────────────

export type OdooStatus = 'ok' | 'not_configured' | 'error'

export interface OdooEnvelope<TRow, TSummary> {
  status: OdooStatus
  resource: string
  pulledAt: string
  query: Record<string, string | number | boolean>
  count: number
  summary: TSummary | null
  rows: TRow[]
  message?: string
  missing?: string[]
}

export interface InventoryRow {
  productId: number | null
  product: string
  location: string
  quantity: number
  reserved: number
}
export interface InventorySummary {
  lines: number
  totalQuantity: number
  outOfStock: number
  lowStock: number
}

export interface TopClientRow {
  partnerId: number | null
  partner: string
  orders: number
  revenue: number
}
export interface TopClientSummary {
  clients: number
  totalRevenue: number
}

export interface DecliningClientRow {
  partnerId: number | null
  partner: string
  priorOrders: number
  priorTotal: number
  recentTotal: number
  dropPct: number
}
export interface DecliningSummary {
  count: number
  avgDropPct: number
}

export interface OverdueInvoiceRow {
  invoice: string
  partner: string
  amount: number
  invoiceDate: string | null
  dueDate: string | null
  paymentState: string
}
export interface OverdueSummary {
  count: number
  totalOverdue: number
}

// ── Knowledge viewer ─────────────────────────────────────────────────────

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

export interface KnowledgeSourcesResponse {
  sources: KnowledgeSource[]
}

export interface KnowledgeDocContent extends KnowledgeDocMeta {
  source: KnowledgeSourceId
  content: string | null
  message?: string
}

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

// ── Data Quality Center ──────────────────────────────────────────────────

export type Severity = 'critical' | 'high' | 'medium' | 'low'

export interface QualityIssue {
  issueId: string
  issueType: string
  category: string
  title: string
  description: string
  severity: Severity
  status: 'open'
  confidence: number
  company: string
  source: { type: string; dataFreshness: 'live' | 'snapshot'; pulledAt: string }
  detectedAt: string
  sourceDate: string | null
  affectedModels: string[]
  affectedRecordCount: number | null
  evidence: { summary: string; samples: string[] }
  businessImpact: string
  affectedMetrics: string[]
  proposedOwner: string | null
  recommendedAction: string
  correctionRequiresWrite: boolean
}

// ── Vault connection (per-user) ──────────────────────────────────────────

export type VaultSource = 'user' | 'env' | 'default'

export interface VaultStatus {
  path: string
  exists: boolean
  isDirectory: boolean
  looksLikeVault: boolean
  hasObsidian: boolean
  hasClaudeDir: boolean
  markdownCount: number
  folders: string[]
  problem?: string
}

export interface VaultConfigResponse {
  source: VaultSource
  status: VaultStatus
}

export interface VaultDetectResponse {
  candidates: VaultStatus[]
}

export interface QualityScan {
  status: 'ok' | 'not_configured' | 'error'
  generatedAt: string
  scanned: string[]
  counts: { total: number; critical: number; high: number; medium: number; low: number }
  issues: QualityIssue[]
  missing?: string[]
  message?: string
}

// ── System Map (GET /api/system-map) ─────────────────────────────────────

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
