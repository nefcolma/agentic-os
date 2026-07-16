import { Router } from 'express'
import {
  getVaultPath,
  getVaultSource,
  inspectVault,
  setVaultPath,
  resetVaultPath,
  detectVaults,
  VaultSettingsError,
} from '../services/vault-settings.js'

export const vaultConfigRouter = Router()

/** Current vault: which folder is connected, where the choice came from, and its health. */
vaultConfigRouter.get('/api/vault/config', (_req, res) => {
  res.json({ source: getVaultSource(), status: inspectVault(getVaultPath()) })
})

/** Dry-run a path without connecting it — powers the "check" button. */
vaultConfigRouter.get('/api/vault/inspect', (req, res) => {
  const p = req.query.path
  if (typeof p !== 'string' || p.trim() === '') {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'query param "path" is required' } })
    return
  }
  res.json({ status: inspectVault(p) })
})

/** Folders on this machine that look like vaults, offered as one-click choices. */
vaultConfigRouter.get('/api/vault/detect', async (_req, res, next) => {
  try {
    res.json({ candidates: await detectVaults() })
  } catch (err) {
    next(err)
  }
})

/** Connect a vault. Validated + persisted; takes effect immediately, no restart. */
vaultConfigRouter.post('/api/vault/config', async (req, res, next) => {
  const p = (req.body as { path?: unknown } | undefined)?.path
  if (typeof p !== 'string') {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'body.path is required' } })
    return
  }
  try {
    const status = await setVaultPath(p)
    res.json({ source: getVaultSource(), status })
  } catch (err) {
    if (err instanceof VaultSettingsError) {
      res.status(400).json({ error: { code: 'INVALID_VAULT', message: err.message, status: err.status } })
      return
    }
    next(err)
  }
})

/** Forget the user's choice and fall back to the env/default vault. */
vaultConfigRouter.post('/api/vault/config/reset', async (_req, res, next) => {
  try {
    const status = await resetVaultPath()
    res.json({ source: getVaultSource(), status })
  } catch (err) {
    next(err)
  }
})
