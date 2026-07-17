import { lookupProducts, odooMissingRequirements } from '../runners/odoo.js'
import type { ProductMatch } from '../runners/odoo.js'

/**
 * Ask router — decides where an answer should come from and, for product/stock
 * questions, does a DETERMINISTIC catalog lookup (product.product, substring
 * `ilike`) so a real product is never reported as nonexistent just because it
 * has no `stock.quant` rows. The result is injected into the Claude prompt as
 * grounded, live data, and returned to the UI as routing metadata.
 */

export type Intent = 'inventory' | 'clients' | 'invoices' | 'general'

export interface Routing {
  intent: Intent
  confidence: number
  route: string
  sources: string[]
  productMatches?: ProductMatch[]
  lookupTerms?: string[]
}

export interface RouteOutcome {
  routing: Routing
  /** Extra context prepended to the question; null when nothing to ground. */
  grounding: string | null
}

const INVENTORY_HINTS = [
  'stock', 'inventory', 'in stock', 'on hand', 'how many', 'units', 'quantity',
  'available', 'reorder', 'out of stock', 'sku', 'urn', 'jewelry', 'keepsake',
]
const CLIENT_HINTS = ['client', 'customer', 'top clients', 'revenue', 'declining', 'account', 'buyer']
const INVOICE_HINTS = ['invoice', 'overdue', 'unpaid', 'past due', 'receivable', 'past-due', ' ar ']

/** Words dropped when extracting a product term — questions words + generic product nouns. */
const NON_DISTINCTIVE = new Set([
  'how', 'many', 'much', 'what', 'which', 'who', 'the', 'are', 'is', 'do', 'we',
  'have', 'has', 'in', 'of', 'a', 'an', 'our', 'my', 'and', 'or', 'to', 'for',
  'with', 'on', 'at', 'this', 'that', 'there', 'stock', 'inventory', 'units',
  'unit', 'quantity', 'available', 'product', 'products', 'item', 'items', 'sku',
  'urn', 'urns', 'wood', 'wooden', 'metal', 'cremation', 'memorial', 'keepsake',
  'keepsakes', 'jewelry', 'large', 'small', 'medium', 'total', 'currently',
  'left', 'remaining', 'count', 'number', 'get', 'show', 'me', 'about', 'right', 'now',
])

function countHits(lower: string, hints: string[]): number {
  return hints.reduce((n, h) => (lower.includes(h) ? n + 1 : n), 0)
}

/** Content words distinctive enough to be a product name (e.g. "sansa", "walnut"). */
function distinctiveTerms(question: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of question.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{1,}/gu) ?? []) {
    if (raw.length < 3 || NON_DISTINCTIVE.has(raw) || seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
  }
  return out.slice(0, 4)
}

function buildGrounding(terms: string[], pulledAt: string, matches: ProductMatch[]): string {
  const head = `LIVE ODOO CATALOG LOOKUP — product.product where name matches [${terms.join(', ')}] (pulled ${pulledAt.slice(0, 19)}Z):`
  if (matches.length === 0) {
    return (
      `${head}\n(no catalog matches)\n` +
      'The product may be named differently. Before concluding it does not exist, you may search Odoo yourself ' +
      'with: python3 .claude/skills/odoo-sync/odoo_sync.py query --model product.product --domain \'[["name","ilike","<term>"]]\' --fields "name,default_code,qty_available".'
    )
  }
  const rows = matches
    .map((m) => `- ${m.name}${m.code ? ` [${m.code}]` : ''} · on hand ${m.onHand} · forecast ${m.forecast}`)
    .join('\n')
  return (
    `${head}\n${rows}\n` +
    'Rules: these are live catalog matches. A product listed here EXISTS even if on-hand is 0 (that means out of stock, ' +
    'NOT nonexistent). Use these exact names / SKUs / quantities; never claim a listed product does not exist.'
  )
}

export async function routeQuestion(question: string): Promise<RouteOutcome> {
  const lower = ` ${question.toLowerCase()} `
  const inv = countHits(lower, INVENTORY_HINTS)
  const cli = countHits(lower, CLIENT_HINTS)
  const inv2 = countHits(lower, INVOICE_HINTS)

  let intent: Intent = 'general'
  let confidence = 0.4
  const max = Math.max(inv, cli, inv2)
  if (max > 0) {
    intent = inv === max ? 'inventory' : cli === max ? 'clients' : 'invoices'
    confidence = Math.min(0.95, 0.6 + max * 0.12)
  }

  const routing: Routing = {
    intent,
    confidence,
    route: intent === 'general' ? 'Vault knowledge' : 'Odoo live',
    sources: intent === 'general' ? ['vault'] : ['Odoo (live)', 'vault'],
  }

  // Only inventory questions get the deterministic catalog grounding.
  if (intent !== 'inventory' || odooMissingRequirements().length > 0) {
    if (intent !== 'general' && odooMissingRequirements().length > 0) {
      routing.route = 'Vault fallback (Odoo not configured)'
      routing.sources = ['vault']
    }
    return { routing, grounding: null }
  }

  const terms = distinctiveTerms(question)
  if (terms.length === 0) {
    routing.route = 'Odoo live · general inventory'
    return { routing, grounding: null }
  }

  try {
    const { pulledAt, matches } = await lookupProducts(terms)
    routing.route = 'Odoo live · catalog lookup'
    routing.sources = ['Odoo product.product (live)']
    routing.productMatches = matches
    routing.lookupTerms = terms
    return { routing, grounding: buildGrounding(terms, pulledAt, matches) }
  } catch {
    // Lookup failed (Odoo down) — let Claude try, don't block the answer.
    routing.route = 'Odoo live · lookup failed, delegating to Claude'
    return { routing, grounding: null }
  }
}
