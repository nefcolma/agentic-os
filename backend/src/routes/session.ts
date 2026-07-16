import { Router } from 'express'

export const sessionRouter = Router()

/** Who the caller is and what they may do — drives the UI's read-only mode. */
sessionRouter.get('/api/session', (req, res) => {
  const session = req.session ?? { email: null, role: 'viewer' as const, source: 'access' as const }
  res.json({
    email: session.email,
    role: session.role,
    source: session.source,
    canWrite: session.role === 'admin',
  })
})
