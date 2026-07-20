import { Router } from 'express'
import { buildSystemMap } from '../services/system-map.js'

/**
 * GET /api/system-map — read-only, typed map of the agentic OS wiring.
 * Executes nothing (no Claude, no routines, no network); only inspects
 * registries, config presence and the filesystem through the service.
 */
export const systemMapRouter = Router()

systemMapRouter.get('/api/system-map', (_req, res, next) => {
  try {
    res.json(buildSystemMap())
  } catch (err) {
    next(err)
  }
})
