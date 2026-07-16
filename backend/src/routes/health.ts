import fs from 'node:fs'
import { Router } from 'express'
import { SERVICE_NAME, SERVICE_VERSION } from '../config/index.js'
import { getVaultPath, getVaultSource } from '../services/vault-settings.js'

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
      path: getVaultPath(),
      exists: fs.existsSync(getVaultPath()),
    },
  }
  res.json(body)
})
