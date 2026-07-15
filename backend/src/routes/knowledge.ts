import { Router } from 'express'
import {
  getKnowledgeSources,
  getKnowledgeDoc,
  exportBakedBundle,
} from '../services/knowledge.js'
import type { KnowledgeSourceId } from '../services/knowledge.js'

export const knowledgeRouter = Router()

function isSourceId(v: unknown): v is KnowledgeSourceId {
  return v === 'drive' || v === 'vault'
}

/** Tree + metadata for both sources (no document content — fetched per-doc). */
knowledgeRouter.get('/api/knowledge/sources', async (_req, res, next) => {
  try {
    res.json({ sources: await getKnowledgeSources() })
  } catch (err) {
    next(err)
  }
})

/** One document's content. Query: source=drive|vault, id=<docId>. */
knowledgeRouter.get('/api/knowledge/doc', async (req, res, next) => {
  try {
    const source = req.query.source
    const id = req.query.id
    if (!isSourceId(source) || typeof id !== 'string' || id === '') {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'Query requires source=drive|vault and id=<docId>' },
      })
      return
    }
    const doc = await getKnowledgeDoc(source, id)
    if (!doc) {
      res.status(404).json({ error: { code: 'DOC_NOT_FOUND', message: 'Unknown document' } })
      return
    }
    res.json({ doc })
  } catch (err) {
    next(err)
  }
})

/** Hybrid on-demand export of a portable baked bundle (written locally, gitignored). */
knowledgeRouter.post('/api/knowledge/export', async (_req, res, next) => {
  try {
    res.json({ export: await exportBakedBundle() })
  } catch (err) {
    if (err instanceof Error && /No knowledge snapshot/.test(err.message)) {
      res.status(503).json({ error: { code: 'NO_SNAPSHOT', message: err.message } })
      return
    }
    next(err)
  }
})
