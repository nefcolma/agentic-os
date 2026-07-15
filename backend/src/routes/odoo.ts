import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  getInventory,
  getTopClients,
  getDecliningClients,
  getOverdueInvoices,
  odooMissingRequirements,
  OdooError,
} from '../runners/odoo.js'
import type { OdooEnvelope } from '../runners/odoo.js'
import { BadRequestError } from '../utils/params.js'
import { redactSecrets } from '../utils/redact.js'

export const odooRouter = Router()

/**
 * Odoo data endpoints always answer 200 with a discriminated `status`
 * (`ok` | `not_configured` | `error`) so the auto-loading dashboard panels
 * can render their five states without treating an expected condition (no
 * credentials, upstream Odoo down) as a thrown HTTP error. Only a malformed
 * request (bad query param) returns 400.
 */
function notConfigured(resource: string, missing: string[]): OdooEnvelope<never, never> {
  return {
    status: 'not_configured',
    resource,
    pulledAt: new Date().toISOString(),
    query: {},
    count: 0,
    summary: null,
    rows: [],
    missing,
    message: 'Odoo is not configured on this machine.',
  }
}

type Puller = (query: Request['query']) => Promise<OdooEnvelope<unknown, unknown>>

function handle(resource: string, puller: Puller) {
  return async (req: Request, res: Response): Promise<void> => {
    const missing = odooMissingRequirements()
    if (missing.length > 0) {
      res.json(notConfigured(resource, missing))
      return
    }
    try {
      res.json(await puller(req.query))
    } catch (err) {
      if (err instanceof BadRequestError) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } })
        return
      }
      // Redact + generalize: never leak stderr detail (may include a connection
      // string) verbatim to the client; full detail stays in the server log.
      const detail = err instanceof OdooError ? redactSecrets(err.message) : 'Odoo query failed'
      console.error(`[odoo:${resource}] ${err instanceof Error ? err.message : String(err)}`)
      res.json({
        status: 'error',
        resource,
        pulledAt: new Date().toISOString(),
        query: {},
        count: 0,
        summary: null,
        rows: [],
        message: detail || 'Odoo query failed',
      })
    }
  }
}

odooRouter.get('/api/odoo/inventory', handle('inventory', (q) => getInventory(q)))
odooRouter.get('/api/odoo/top-clients', handle('top-clients', (q) => getTopClients(q)))
odooRouter.get('/api/odoo/declining-clients', handle('declining-clients', (q) => getDecliningClients(q)))
odooRouter.get('/api/odoo/overdue-invoices', handle('overdue-invoices', (q) => getOverdueInvoices(q)))
