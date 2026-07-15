import { Router } from 'express'
import { runQualityScan } from '../services/quality/index.js'

export const qualityRouter = Router()

/**
 * Data Quality Center scan. Always 200 with a discriminated status; the panel
 * renders ok / not_configured / error itself. Detection-only — this endpoint
 * never writes to Odoo or the vault.
 */
qualityRouter.get('/api/quality/issues', async (_req, res, next) => {
  try {
    res.json(await runQualityScan())
  } catch (err) {
    next(err)
  }
})
