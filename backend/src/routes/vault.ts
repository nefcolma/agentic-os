import { Router } from 'express'
import { getVaultSummary, VaultNotFoundError } from '../services/vault.js'

export const vaultRouter = Router()

vaultRouter.get('/api/vault-summary', async (_req, res, next) => {
  try {
    res.json(await getVaultSummary())
  } catch (err) {
    if (err instanceof VaultNotFoundError) {
      res.status(503).json({ error: { code: 'VAULT_NOT_FOUND', message: err.message } })
      return
    }
    next(err)
  }
})
