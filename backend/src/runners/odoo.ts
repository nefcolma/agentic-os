import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { config } from '../config/index.js'
import { redactSecrets } from '../utils/redact.js'
import { BadRequestError } from '../utils/params.js'
import { getVaultPath, vaultPaths } from '../services/vault-settings.js'

/**
 * OdooRunner — deterministic, read-only Odoo access.
 *
 * Calls `python3 odoo_sync.py <subcommand> …` DIRECTLY (never through
 * `claude -p`): these are pure `search_read` pulls, so there is no reasoning,
 * no token cost and no write risk (PRD §5.2, "read-only data fetches").
 *
 * Invariants:
 *  - spawn with a fixed argv array, shell:false — no interpolation, no shell.
 *  - Only whitelisted subcommands; every parameter is validated and typed
 *    before it becomes an argv entry.
 *  - Odoo credentials come from the process environment (never from the
 *    request, never logged); stdout data is not secret, but any error text is
 *    redacted before it can reach the frontend.
 *  - The odoo_sync.py bridge is read-only by construction (search_read only).
 */

const LOW_STOCK_THRESHOLD = 10

export type OdooStatus = 'ok' | 'not_configured' | 'error'

export interface OdooEnvelope<TRow, TSummary> {
  status: OdooStatus
  resource: string
  pulledAt: string
  query: Record<string, string | number | boolean>
  count: number
  summary: TSummary | null
  rows: TRow[]
  /** Present only when status !== 'ok'. Redacted, generic. */
  message?: string
  /** Present only when status === 'not_configured'. Names/paths, never values. */
  missing?: string[]
}

/** Required environment for any Odoo pull — presence only, values never read into messages. */
const REQUIRED_ODOO_ENV = ['ODOO_URL', 'ODOO_USERNAME', 'ODOO_API_KEY'] as const

export function odooMissingRequirements(): string[] {
  const missing: string[] = []
  if (!fs.existsSync(vaultPaths().odooScript)) missing.push(`odoo script ${vaultPaths().odooScript}`)
  for (const key of REQUIRED_ODOO_ENV) {
    if (!process.env[key]) missing.push(`env ${key}`)
  }
  return missing
}

interface RawSpawnResult {
  code: number | null
  stdout: string
  stderr: string
}

function runScript(subcommand: string, args: string[]): Promise<RawSpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.pythonBin, [vaultPaths().odooScript, subcommand, ...args], {
      cwd: getVaultPath(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    const MAX_STDOUT = 8 * 1024 * 1024 // guard against a runaway pull

    child.stdout.on('data', (c: Buffer) => {
      stdoutBytes += c.length
      if (stdoutBytes <= MAX_STDOUT) stdoutChunks.push(c)
    })
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c))

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new OdooError('Odoo query timed out'))
    }, config.timeouts.odooMs)
    timer.unref()

    child.on('error', (err) => {
      clearTimeout(timer)
      // e.g. python3 not found — redact defensively.
      reject(new OdooError(`failed to launch odoo script: ${redactSecrets(err.message)}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (stdoutBytes > MAX_STDOUT) {
        reject(new OdooError('Odoo response too large'))
        return
      }
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      })
    })
  })
}

export class OdooError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OdooError'
  }
}

/** Runs a subcommand and parses its JSON stdout, mapping failures to OdooError. */
async function pull<T>(subcommand: string, args: string[]): Promise<T[]> {
  const result = await runScript(subcommand, args)
  if (result.code !== 0) {
    // stderr may echo a connection string on failure — redact before surfacing.
    const detail = redactSecrets(result.stderr.trim()) || `exit code ${String(result.code)}`
    throw new OdooError(detail)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new OdooError('Odoo script returned unparseable output')
  }
  if (!Array.isArray(parsed)) {
    throw new OdooError('Odoo script returned an unexpected shape')
  }
  return parsed as T[]
}

/** Drops read_group bookkeeping keys (__domain, __count, __range …). */
function stripInternalKeys<T extends Record<string, unknown>>(row: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (!k.startsWith('__')) out[k] = v
  }
  return out as Partial<T>
}

/** Odoo many2one fields arrive as [id, "Display Name"]; pull the label out safely. */
function m2oName(value: unknown): string {
  return Array.isArray(value) && typeof value[1] === 'string' ? value[1] : ''
}
function m2oId(value: unknown): number | null {
  return Array.isArray(value) && typeof value[0] === 'number' ? value[0] : null
}
function num(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

// ── Validation ─────────────────────────────────────────────────────────────

function boundedInt(name: string, raw: unknown, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw.trim())) {
    throw new BadRequestError(`Query param "${name}" must be an integer`)
  }
  const v = Number.parseInt(raw, 10)
  if (v < min || v > max) throw new BadRequestError(`Query param "${name}" must be between ${min} and ${max}`)
  return v
}

function parseBool(name: string, raw: unknown): boolean {
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') return false
  if (raw === 'true' || raw === '1') return true
  throw new BadRequestError(`Query param "${name}" must be true or false`)
}

function parseProduct(raw: unknown): string | undefined {
  if (raw === undefined || raw === '') return undefined
  if (typeof raw !== 'string') throw new BadRequestError('Query param "product" must be a single value')
  const cleaned = raw.replace(/[\r\n]/g, ' ').trim()
  if (cleaned.length > 100) throw new BadRequestError('Query param "product" is too long (max 100 chars)')
  return cleaned
}

// ── Typed row / summary shapes ───────────────────────────────────────────────

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

// ── Public API — one method per endpoint ─────────────────────────────────────

export async function getInventory(query: {
  product?: unknown
  limit?: unknown
}): Promise<OdooEnvelope<InventoryRow, InventorySummary>> {
  const product = parseProduct(query.product)
  const limit = boundedInt('limit', query.limit, 50, 1, 500)
  const args = ['--limit', String(limit)]
  if (product !== undefined) args.push('--product', product)

  const raw = await pull<Record<string, unknown>>('inventory', args)
  const rows: InventoryRow[] = raw.map((r) => ({
    productId: m2oId(r.product_id),
    product: m2oName(r.product_id),
    location: m2oName(r.location_id),
    quantity: num(r.quantity),
    reserved: num(r.reserved_quantity),
  }))
  const summary: InventorySummary = {
    lines: rows.length,
    totalQuantity: Math.round(rows.reduce((s, r) => s + r.quantity, 0) * 100) / 100,
    outOfStock: rows.filter((r) => r.quantity <= 0).length,
    lowStock: rows.filter((r) => r.quantity > 0 && r.quantity < LOW_STOCK_THRESHOLD).length,
  }
  return envelope('inventory', { ...(product ? { product } : {}), limit }, rows, summary)
}

export async function getTopClients(query: {
  days?: unknown
  limit?: unknown
  businessOnly?: unknown
}): Promise<OdooEnvelope<TopClientRow, TopClientSummary>> {
  const days = boundedInt('days', query.days, 30, 1, 365)
  const limit = boundedInt('limit', query.limit, 10, 1, 100)
  const businessOnly = parseBool('businessOnly', query.businessOnly)
  const args = ['--days', String(days), '--limit', String(limit)]
  if (businessOnly) args.push('--business-only')

  const raw = await pull<Record<string, unknown>>('top-clients', args)
  const rows: TopClientRow[] = raw.map(stripInternalKeys).map((r) => ({
    partnerId: m2oId(r.partner_id),
    partner: m2oName(r.partner_id),
    orders: num(r.partner_id_count),
    revenue: Math.round(num(r.amount_total) * 100) / 100,
  }))
  const summary: TopClientSummary = {
    clients: rows.length,
    totalRevenue: Math.round(rows.reduce((s, r) => s + r.revenue, 0) * 100) / 100,
  }
  return envelope('top-clients', { days, limit, businessOnly }, rows, summary)
}

export async function getDecliningClients(query: {
  days?: unknown
  limit?: unknown
  minOrders?: unknown
  businessOnly?: unknown
}): Promise<OdooEnvelope<DecliningClientRow, DecliningSummary>> {
  const days = boundedInt('days', query.days, 30, 1, 365)
  const limit = boundedInt('limit', query.limit, 10, 1, 100)
  const minOrders = boundedInt('minOrders', query.minOrders, 2, 1, 100)
  const businessOnly = parseBool('businessOnly', query.businessOnly)
  const args = ['--days', String(days), '--limit', String(limit), '--min-orders', String(minOrders)]
  if (businessOnly) args.push('--business-only')

  const raw = await pull<Record<string, unknown>>('declining-clients', args)
  const rows: DecliningClientRow[] = raw.map((r) => ({
    partnerId: m2oId(r.partner_id) ?? (typeof r.partner_id === 'number' ? r.partner_id : null),
    partner: typeof r.partner_name === 'string' ? r.partner_name : '',
    priorOrders: num(r.prior_period_orders),
    priorTotal: Math.round(num(r.prior_period_total) * 100) / 100,
    recentTotal: Math.round(num(r.recent_period_total) * 100) / 100,
    dropPct: num(r.drop_pct),
  }))
  const summary: DecliningSummary = {
    count: rows.length,
    avgDropPct:
      rows.length === 0 ? 0 : Math.round((rows.reduce((s, r) => s + r.dropPct, 0) / rows.length) * 10) / 10,
  }
  return envelope('declining-clients', { days, limit, minOrders, businessOnly }, rows, summary)
}

export async function getOverdueInvoices(query: {
  limit?: unknown
}): Promise<OdooEnvelope<OverdueInvoiceRow, OverdueSummary>> {
  const limit = boundedInt('limit', query.limit, 50, 1, 500)
  const raw = await pull<Record<string, unknown>>('overdue-invoices', ['--limit', String(limit)])
  const rows: OverdueInvoiceRow[] = raw.map((r) => ({
    invoice: typeof r.name === 'string' ? r.name : '',
    partner: m2oName(r.partner_id),
    amount: Math.round(num(r.amount_total) * 100) / 100,
    invoiceDate: typeof r.invoice_date === 'string' ? r.invoice_date : null,
    dueDate: typeof r.invoice_date_due === 'string' ? r.invoice_date_due : null,
    paymentState: typeof r.payment_state === 'string' ? r.payment_state : '',
  }))
  const summary: OverdueSummary = {
    count: rows.length,
    totalOverdue: Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100,
  }
  return envelope('overdue-invoices', { limit }, rows, summary)
}

function envelope<TRow, TSummary>(
  resource: string,
  query: Record<string, string | number | boolean>,
  rows: TRow[],
  summary: TSummary,
): OdooEnvelope<TRow, TSummary> {
  return {
    status: 'ok',
    resource,
    pulledAt: new Date().toISOString(),
    query,
    count: rows.length,
    summary,
    rows,
  }
}
