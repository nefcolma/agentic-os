import { Router } from 'express'
import { ask, AskError } from '../services/ask.js'

export const askRouter = Router()

/**
 * Ask the Brain. POST — so the read-only Access role is blocked by roleGuard
 * (asking spawns a Claude process on the owner's subscription).
 */
askRouter.post('/api/ask', async (req, res) => {
  const question = (req.body as { question?: unknown } | undefined)?.question
  try {
    res.json({ result: await ask(question) })
  } catch (err) {
    if (err instanceof AskError) {
      const status = err.code === 'BAD_REQUEST' ? 400 : err.code === 'BUSY' ? 429 : 502
      res.status(status).json({ error: { code: err.code, message: err.message } })
      return
    }
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Ask failed' } })
  }
})
