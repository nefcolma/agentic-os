import { Router } from 'express'
import { regeneratePreview, regenerateApply, RegenerateError } from '../services/regenerate.js'

export const regenerateRouter = Router()

function handleError(res: import('express').Response, err: unknown): void {
  if (err instanceof RegenerateError) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'BAD_CONTENT' ? 400 : 502
    res.status(status).json({ error: { code: err.code, message: err.message } })
    return
  }
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Regenerate failed' } })
}

/**
 * Step 1 — preview: generate a proposed refresh of a vault note (read-only).
 * Writes nothing. Body: { id }.
 */
regenerateRouter.post('/api/regenerate/preview', async (req, res) => {
  const id = (req.body as { id?: unknown } | undefined)?.id
  if (typeof id !== 'string' || id === '') {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'body.id (vault doc id) is required' } })
    return
  }
  try {
    res.json({ preview: await regeneratePreview(id) })
  } catch (err) {
    handleError(res, err)
  }
})

/**
 * Step 2 — apply: overwrite the note with the exact user-approved content.
 * Only ever called after the UI's explicit confirm of the diff. Body:
 * { id, approvedContent }.
 */
regenerateRouter.post('/api/regenerate/apply', async (req, res) => {
  const body = (req.body ?? {}) as { id?: unknown; approvedContent?: unknown }
  if (typeof body.id !== 'string' || body.id === '' || typeof body.approvedContent !== 'string') {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'body.id and body.approvedContent are required' } })
    return
  }
  try {
    res.json({ applied: await regenerateApply(body.id, body.approvedContent) })
  } catch (err) {
    handleError(res, err)
  }
})
