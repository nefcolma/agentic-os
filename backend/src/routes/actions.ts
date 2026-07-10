import { Router } from 'express'
import { CLAUDE_ACTION_SPECS } from '../runners/claude-actions.js'
import { startRun, startRunHandler } from './runs.js'

export const actionsRouter = Router()

/**
 * Availability catalog for the Actions panel. Returns names, endpoints and
 * missing requirement labels (file paths / env var NAMES) — never prompt
 * content, never env values.
 */
actionsRouter.get('/api/actions', (_req, res) => {
  const actions = CLAUDE_ACTION_SPECS.map((spec) => {
    const missing = spec.checkMissing()
    return {
      kind: spec.kind,
      title: spec.title,
      description: spec.description,
      group: spec.mutexGroup,
      configured: missing.length === 0,
      missing,
    }
  })
  res.json({ actions })
})

// Each endpoint maps to exactly one fixed backend definition (PRD §5.2).
actionsRouter.post('/api/run/inbox-classify', startRunHandler('inbox-classify'))
actionsRouter.post('/api/run/nightly-consolidation', startRunHandler('nightly-consolidation'))
actionsRouter.post('/api/run/weekly-digest', startRunHandler('weekly-digest'))
actionsRouter.post('/api/run/auth-probe', startRunHandler('auth-probe'))

/**
 * GHL sync takes `{ business: "colma" | "upd-urns" }` and maps it through a
 * fixed lookup — the body value selects between two predefined definitions
 * and is never interpolated into anything.
 */
const GHL_KIND_BY_BUSINESS: Record<string, string> = {
  colma: 'ghl-sync-colma',
  'upd-urns': 'ghl-sync-upd-urns',
}

actionsRouter.post('/api/run/ghl-sync', (req, res) => {
  const business: unknown = (req.body as { business?: unknown } | undefined)?.business
  const kind = typeof business === 'string' ? GHL_KIND_BY_BUSINESS[business] : undefined
  if (kind === undefined) {
    res.status(400).json({
      error: {
        code: 'BAD_REQUEST',
        message: 'body.business must be "colma" or "upd-urns"',
      },
    })
    return
  }
  startRun(kind, res)
})
