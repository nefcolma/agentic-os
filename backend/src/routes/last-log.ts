import path from 'node:path'
import { Router } from 'express'
import { config } from '../config/index.js'
import { getVaultPath } from '../services/vault-settings.js'
import { tailFile } from '../utils/tail.js'
import { BadRequestError, parseBoundedInt } from '../utils/params.js'

const NIGHTLY_LOG_RELATIVE = path.join('.claude', 'nightly.log')

export interface LastLogResponse {
  available: boolean
  path: string
  reason?: 'not_found'
  message?: string
  sizeBytes?: number
  modifiedAt?: string
  lineCount?: number
  truncated?: boolean
  lines?: string[]
}

export const lastLogRouter = Router()

lastLogRouter.get('/api/last-log', async (req, res, next) => {
  try {
    const lines = parseBoundedInt('lines', req.query.lines, config.logs.lastLogDefaultLines, 1, 5_000)
    const logAbs = path.join(getVaultPath(), NIGHTLY_LOG_RELATIVE)
    const tail = await tailFile(logAbs, lines, config.logs.maxRunLogBytes)

    if (tail === null) {
      const body: LastLogResponse = {
        available: false,
        path: NIGHTLY_LOG_RELATIVE,
        reason: 'not_found',
        message: 'nightly.log does not exist yet — no nightly consolidation has run.',
      }
      res.json(body)
      return
    }

    const body: LastLogResponse = {
      available: true,
      path: NIGHTLY_LOG_RELATIVE,
      sizeBytes: tail.sizeBytes,
      modifiedAt: tail.modifiedAt,
      lineCount: tail.lines.length,
      truncated: tail.truncated,
      lines: tail.lines,
    }
    res.json(body)
  } catch (err) {
    if (err instanceof BadRequestError) {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } })
      return
    }
    next(err)
  }
})
