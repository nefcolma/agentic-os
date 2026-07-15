import { makeIssue } from './issue.js'
import type { QualityIssue, QualitySource } from './issue.js'
import type {
  InventoryRow,
  TopClientRow,
  DecliningClientRow,
  OverdueInvoiceRow,
} from '../../runners/odoo.js'

/**
 * Deterministic detectors over REAL live Odoo data. Each combines concrete
 * signals — no business conclusion is invented, and an empty result is a
 * valid, honest outcome (no findings fabricated to fill the panel).
 */

const CONFIG = {
  lowResidualThreshold: 5, // $/invoice below this looks like ledger noise
  lowResidualMinCount: 25, // ...only when the volume is meaningful
  negativeForecastHigh: 50, // |negative qty| above this → high severity
  negativeForecastCritical: 1000,
}

const OWNER = {
  finance: 'Finance (proposed)',
  inventory: 'Production / Inventory (proposed)',
  sales: 'Sales / CRM (proposed)',
}

/** Normalizes an Odoo partner display name to a comparison key. */
function customerKey(name: string): string {
  return name
    .split(',')[0]!
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
}

/** A. NEGATIVE_INVENTORY — negative on-hand / virtual availability. */
export function detectNegativeInventory(rows: InventoryRow[], source: QualitySource): QualityIssue[] {
  const negatives = rows.filter((r) => r.quantity < 0)
  if (negatives.length === 0) return []
  const worst = [...negatives].sort((a, b) => a.quantity - b.quantity)
  const maxMag = Math.abs(worst[0]!.quantity)
  const severity =
    maxMag >= CONFIG.negativeForecastCritical ? 'critical' : maxMag >= CONFIG.negativeForecastHigh ? 'high' : 'medium'
  return [
    makeIssue({
      issueType: 'NEGATIVE_INVENTORY',
      category: 'Inventory integrity',
      title: `${negatives.length} inventory line${negatives.length === 1 ? '' : 's'} with negative quantity`,
      description: `${negatives.length} stock lines report a negative quantity — an impossible physical stock level that usually points to an inventory transaction error (a broken receipt, a duplicated delivery, or a unit-of-measure mistake). Largest: ${worst
        .slice(0, 3)
        .map((r) => `${r.product || '(unnamed)'} (${r.quantity})`)
        .join('; ')}.`,
      severity,
      confidence: 0.9,
      source,
      sourceDate: source.pulledAt,
      affectedModels: ['stock.quant', 'stock.move'],
      affectedRecordCount: negatives.length,
      evidence: {
        summary: `Live stock.quant rows with quantity < 0 (${negatives.length} of ${rows.length} sampled).`,
        samples: worst.slice(0, 5).map((r) => `${r.product || '(unnamed)'}: ${r.quantity}`),
      },
      businessImpact:
        'Distorts total inventory valuation and replenishment planning; any KPI built on on-hand quantities inherits the error.',
      affectedMetrics: ['Total Inventory Value', 'Out-of-stock %', 'Reorder accuracy'],
      proposedOwner: OWNER.inventory,
      recommendedAction:
        'Investigate the stock moves behind each negative line to find the broken transaction. Any inventory adjustment is a write and would require explicit confirmation — inventory is never adjusted automatically.',
      correctionRequiresWrite: true,
    }),
  ]
}

/** B. MISSING_PRODUCT_IDENTIFIER — product names without a [SKU]-style code. */
export function detectMissingIdentifiers(rows: InventoryRow[], source: QualitySource): QualityIssue[] {
  const named = rows.filter((r) => r.product && r.product.trim() !== '')
  const missing = named.filter((r) => !/^\s*\[[A-Za-z0-9-]+\]/.test(r.product) && !/^[A-Z0-9]{3,}[-\s]/.test(r.product))
  if (missing.length === 0) return []
  return [
    makeIssue({
      issueType: 'MISSING_PRODUCT_IDENTIFIER',
      category: 'Catalog hygiene',
      title: `${missing.length} inventory line${missing.length === 1 ? '' : 's'} without a SKU-style code`,
      description: `${missing.length} of ${named.length} named inventory lines have no leading [code]/default_code-style identifier (e.g. ${missing
        .slice(0, 2)
        .map((r) => `"${r.product}"`)
        .join('; ')}). Products without a stable code cannot be reliably matched across Odoo, Shopify, Magento, and the website.`,
      severity: 'medium',
      confidence: 0.6,
      source,
      sourceDate: source.pulledAt,
      affectedModels: ['product.template', 'product.product'],
      affectedRecordCount: missing.length,
      evidence: {
        summary: 'Live inventory rows whose product label lacks a [code] prefix.',
        samples: missing.slice(0, 5).map((r) => r.product),
      },
      businessImpact:
        'Breaks cross-channel product matching, reorder calculations, and out-of-stock reporting for the affected records.',
      affectedMetrics: ['Out-of-stock %', 'Inventory reorder accuracy'],
      proposedOwner: OWNER.inventory,
      recommendedAction:
        'Assign default_code values to the affected catalog records. Setting a field is a write and would require explicit confirmation.',
      correctionRequiresWrite: true,
    }),
  ]
}

/** C. DUPLICATE_CUSTOMER — one normalized customer under multiple partner names. */
export function detectDuplicateCustomers(
  top: TopClientRow[],
  declining: DecliningClientRow[],
  source: QualitySource,
): QualityIssue[] {
  const groups = new Map<string, Set<string>>()
  for (const r of top) if (r.partner) addName(groups, r.partner)
  for (const r of declining) if (r.partner) addName(groups, r.partner)

  const dupes = [...groups.entries()].filter(([, names]) => names.size >= 2)
  if (dupes.length === 0) return []
  const worst = dupes.sort((a, b) => b[1].size - a[1].size)
  return [
    makeIssue({
      issueType: 'DUPLICATE_CUSTOMER',
      category: 'CRM / partner integrity',
      title: `${dupes.length} customer${dupes.length === 1 ? '' : 's'} likely split across duplicate partner records`,
      description: `${dupes.length} normalized customer key(s) appear under 2+ distinct Odoo partner names across the client rankings — e.g. "${worst[0]![0]}" as ${[
        ...worst[0]![1],
      ].join(' · ')}. Revenue and decline signals get split across the records, so the same customer can rank as a top client and a declining client at once.`,
      severity: worst[0]![1].size >= 3 ? 'high' : 'medium',
      confidence: worst[0]![1].size >= 3 ? 0.8 : 0.6,
      source,
      sourceDate: source.pulledAt,
      affectedModels: ['res.partner', 'sale.order'],
      affectedRecordCount: dupes.length,
      evidence: {
        summary: 'Matching normalized name keys across live top-clients + declining-clients rankings.',
        samples: worst.slice(0, 5).map(([k, names]) => `${k}: ${[...names].join(' | ')}`),
      },
      businessImpact:
        'Splits customer revenue history, distorts top-client and declining-client rankings, and skews reactivation and CAC metrics.',
      affectedMetrics: ['Top clients ranking', 'Declining clients', 'Reactivated accounts', 'CAC'],
      proposedOwner: OWNER.sales,
      recommendedAction:
        'Review the partner records side by side and prepare a merge proposal. Merging is a write and would require explicit confirmation — records are never merged automatically.',
      correctionRequiresWrite: true,
    }),
  ]
}

function addName(groups: Map<string, Set<string>>, partner: string): void {
  const key = customerKey(partner)
  if (!key || key.length < 4) return
  if (!groups.has(key)) groups.set(key, new Set())
  groups.get(key)!.add(partner)
}

/** D. LOW_RESIDUAL_OVERDUE — many "overdue" invoices with near-zero amounts. */
export function detectLowResidualOverdue(
  rows: OverdueInvoiceRow[],
  source: QualitySource,
): QualityIssue[] {
  const tiny = rows.filter((r) => r.amount > 0 && r.amount < CONFIG.lowResidualThreshold)
  if (tiny.length < CONFIG.lowResidualMinCount) return []
  const total = tiny.reduce((s, r) => s + r.amount, 0)
  return [
    makeIssue({
      issueType: 'LOW_RESIDUAL_OVERDUE_INVOICE',
      category: 'AR / ledger hygiene',
      title: `${tiny.length} "overdue" invoices carry a near-zero residual`,
      description: `${tiny.length} posted invoices are flagged overdue but each carries under $${CONFIG.lowResidualThreshold} (total $${total.toFixed(
        2,
      )}). This pattern is usually reconciliation noise — payments that never closed the residual — not real debt, and it inflates the AR aging view.`,
      severity: 'high',
      confidence: 0.85,
      source,
      sourceDate: source.pulledAt,
      affectedModels: ['account.move'],
      affectedRecordCount: tiny.length,
      evidence: {
        summary: `Live overdue invoices with amount < $${CONFIG.lowResidualThreshold}.`,
        samples: tiny.slice(0, 5).map((r) => `${r.invoice}: $${r.amount}`),
      },
      businessImpact:
        'Inflates the overdue-invoice count and buries genuinely overdue money, blocking the AR-aging goal from being measured accurately.',
      affectedMetrics: ['AR aging 90+', 'Overdue invoice count'],
      proposedOwner: OWNER.finance,
      recommendedAction:
        'Sample the set, confirm the zero-residual pattern, then prepare a batch reconciliation-close proposal. Reconciling or closing invoices is a write and would require explicit confirmation.',
      correctionRequiresWrite: true,
    }),
  ]
}

/** E. INCOMPLETE_CUSTOMER_RECORD — partner labels with a duplicated name segment. */
export function detectIncompleteCustomers(
  rows: OverdueInvoiceRow[],
  source: QualitySource,
): QualityIssue[] {
  const suspects = rows.filter((r) => {
    const parts = r.partner.split(',').map((s) => s.trim())
    return parts.length >= 2 && parts[0] !== '' && parts[0] === parts[1]
  })
  if (suspects.length === 0) return []
  return [
    makeIssue({
      issueType: 'INCOMPLETE_CUSTOMER_RECORD',
      category: 'CRM / partner integrity',
      title: `${suspects.length} invoice partner${suspects.length === 1 ? '' : 's'} show a duplicated name segment`,
      description: `${suspects.length} overdue-invoice partner labels repeat the same name on both sides of the comma (e.g. "${suspects[0]!.partner}"). This often means the contact and its parent company record are the same entity, or a partner record is missing its company/parent — a sign of an incomplete res.partner record.`,
      severity: 'low',
      confidence: 0.55,
      source,
      sourceDate: source.pulledAt,
      affectedModels: ['res.partner'],
      affectedRecordCount: suspects.length,
      evidence: {
        summary: 'Live invoice partner display names with an identical repeated segment.',
        samples: suspects.slice(0, 5).map((r) => r.partner),
      },
      businessImpact:
        'Ambiguous partner hierarchy makes customer-level rollups and statements less reliable.',
      affectedMetrics: ['Customer-level AR', 'Partner hierarchy'],
      proposedOwner: OWNER.finance,
      recommendedAction:
        'Review whether the contact and company records should be linked or completed. Editing partner records is a write and would require explicit confirmation.',
      correctionRequiresWrite: true,
    }),
  ]
}
