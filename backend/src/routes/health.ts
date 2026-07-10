import fs from 'node:fs'
import { Router } from 'express'
import { config, SERVICE_NAME, SERVICE_VERSION } from '../config/index.js'

export interface HealthResponse {
  status: 'ok'
  service: string
  version: string
  timestamp: string
  uptimeSeconds: number
  vault: {
    path: string
    exists: boolean
  }
}

export const healthRouter = Router()

healthRouter.get('/api/health', (_req, res) => {
  const body: HealthResponse = {
    status: 'ok',
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    vault: {
      path: config.vaultPath,
      exists: fs.existsSync(config.vaultPath),
    },
  }
  res.json(body)
})
