import { Router } from 'express'
import type { Request, Response } from 'express'
import { runManager } from '../services/index.js'
import { RunConflictError, UnknownRunKindError } from '../services/run-manager.js'
import { NotConfiguredError } from '../runners/claude.js'
import { config } from '../config/index.js'

export const runsRouter = Router()

const FINISHED = new Set(['succeeded', 'failed', 'cancelled'])

function notFound(res: Response): void {
  res.status(404).json({ error: { code: 'RUN_NOT_FOUND', message: 'Unknown run id' } })
}

/**
 * Starts a run by kind and writes the HTTP response. The kind is the ONLY
 * input ever taken from a request — command/args/cwd live in the backend
 * registry. There is no generic "run anything" endpoint.
 */
export function startRun(kind: string, res: Response): void {
  try {
    const run = runManager.start(kind)
    res.status(202).json({ run })
  } catch (err) {
    if (err instanceof RunConflictError) {
      res.status(409).json({
        error: {
          code: 'RUN_IN_PROGRESS',
          message: err.message,
          activeRunId: err.activeRun.id,
        },
      })
      return
    }
    if (err instanceof NotConfiguredError) {
      res.status(503).json({
        error: { code: 'NOT_CONFIGURED', message: err.message, missing: err.missing },
      })
      return
    }
    if (err instanceof UnknownRunKindError) {
      res.status(404).json({ error: { code: 'UNKNOWN_RUN_KIND', message: err.message } })
      return
    }
    throw err
  }
}

export function startRunHandler(kind: string) {
  return (_req: Request, res: Response): void => startRun(kind, res)
}

// Phase 3: only the fixed, harmless diagnostic run is exposed.
runsRouter.post('/api/run/self-test', startRunHandler('self-test'))

runsRouter.get('/api/runs', (_req, res) => {
  res.json({ runs: runManager.list() })
})

runsRouter.get('/api/runs/:id', (req, res) => {
  const id = req.params.id
  const run = runManager.get(id)
  if (!run) return notFound(res)
  res.json({
    run,
    log: {
      truncatedHead: run.logTruncatedHead,
      lines: runManager.getLogLines(id) ?? [],
    },
  })
})

runsRouter.post('/api/runs/:id/cancel', (req, res) => {
  const run = runManager.cancel(req.params.id)
  if (!run) return notFound(res)
  res.json({ run })
})

/**
 * Server-Sent Events stream for one run: replays the (already redacted)
 * retained log, then follows live. Event types:
 *   line   — one log line, id: <seq> so clients can resume via Last-Event-ID
 *   status — run info on every state change
 *   end    — final run info; the server closes the stream afterwards
 */
runsRouter.get('/api/runs/:id/stream', (req, res) => {
  const id = req.params.id
  const run = runManager.get(id)
  if (!run) return notFound(res)

  const lastEventId = req.get('last-event-id')
  const sinceSeq =
    lastEventId !== undefined && /^\d+$/.test(lastEventId) ? Number.parseInt(lastEventId, 10) : 0

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 5000\n\n')

  const send = (event: string, data: unknown, eventId?: number): void => {
    if (eventId !== undefined) res.write(`id: ${eventId}\n`)
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  // Replay + subscribe happen synchronously on the event loop, so no line
  // can slip between the snapshot and the subscription.
  for (const line of runManager.getLogLines(id, sinceSeq) ?? []) {
    send('line', line, line.seq)
  }
  const current = runManager.get(id)
  if (!current) {
    res.end()
    return
  }
  send('status', current)

  if (FINISHED.has(current.status)) {
    send('end', current)
    res.end()
    return
  }

  let closed = false
  const heartbeat = setInterval(() => {
    res.write(': hb\n\n')
  }, config.runs.sseHeartbeatMs)

  const unsubscribe = runManager.subscribe(id, {
    line: (line) => send('line', line, line.seq),
    update: (info) => send('status', info),
    end: (info) => {
      send('end', info)
      cleanup()
      res.end()
    },
  })

  // Single cleanup path: no timers or listeners survive the connection.
  function cleanup(): void {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
  }

  req.on('close', cleanup)
  res.on('close', cleanup)
})
