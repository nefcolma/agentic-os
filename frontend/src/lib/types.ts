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
