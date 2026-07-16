import express from 'express'
import type { ErrorRequestHandler, RequestHandler } from 'express'
import { healthRouter } from './routes/health.js'
import { vaultRouter } from './routes/vault.js'
import { lastLogRouter } from './routes/last-log.js'
import { runsRouter } from './routes/runs.js'
import { actionsRouter } from './routes/actions.js'
import { odooRouter } from './routes/odoo.js'
import { knowledgeRouter } from './routes/knowledge.js'
import { qualityRouter } from './routes/quality.js'
import { regenerateRouter } from './routes/regenerate.js'
import { vaultConfigRouter } from './routes/vault-config.js'
import { hostGuard, csrfGuard } from './middleware/security.js'

const apiNotFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown API route' } })
}

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // Structured error to the client; full detail only in the server console.
  console.error('[api] unhandled error:', err)
  const message = err instanceof Error ? err.message : 'Unexpected error'
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } })
}

export function createApp(): express.Express {
  const app = express()
  app.disable('x-powered-by')

  // Guards run before any route: binding to loopback keeps the network out, but
  // a page in the user's own browser can still reach us. hostGuard blocks DNS
  // rebinding; csrfGuard blocks cross-site state-changing requests.
  app.use(hostGuard)
  app.use(csrfGuard)
  app.use(express.json({ limit: '1mb' }))

  app.use(healthRouter)
  app.use(vaultRouter)
  app.use(lastLogRouter)
  app.use(runsRouter)
  app.use(actionsRouter)
  app.use(odooRouter)
  app.use(knowledgeRouter)
  app.use(qualityRouter)
  app.use(regenerateRouter)
  app.use(vaultConfigRouter)

  app.use('/api', apiNotFound)
  app.use(errorHandler)
  return app
}
