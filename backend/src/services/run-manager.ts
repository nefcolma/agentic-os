import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import { BoundedRunLog } from './run-log.js'
import type { RunLogLine } from './run-log.js'
import type { Redactor } from '../utils/redact.js'

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface RunInfo {
  id: string
  kind: string
  title: string
  status: RunStatus
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  cancelRequested: boolean
  /** Launcher/summary error — never raw process output, always redacted. */
  error: string | null
  logBytes: number
  logTruncatedHead: boolean
}

/**
 * A run definition is the ONLY way a process gets launched: fixed command,
 * fixed args builder, fixed cwd — nothing about the executable, arguments or
 * shell ever comes from an HTTP request. spawn() is always used with an args
 * array and never with `shell: true`.
 */
export interface RunDefinition {
  kind: string
  title: string
  /** Two runs sharing a mutex group can never execute concurrently. */
  mutexGroup: string
  timeoutMs: number
  /**
   * Configuration gate, called BEFORE a run record exists. Throwing here
   * (e.g. NotConfiguredError) rejects the start cleanly with no side effects.
   */
  preflight?(): void
  build(): {
    command: string
    args: string[]
    cwd: string
    /**
     * COMPLETE child environment when provided (definitions that need it,
     * e.g. ClaudeRunner, build a sanitized copy themselves); when omitted the
     * child inherits process.env. Never sent to clients either way.
     */
    env?: Record<string, string>
    /**
     * Optional provenance note logged as a system line (e.g. prompt source
     * path + length). Must never contain prompt content or secrets.
     */
    note?: string
  }
}

export class RunConflictError extends Error {
  constructor(public readonly activeRun: RunInfo) {
    super(
      `A conflicting run is already active (${activeRun.kind}, id=${activeRun.id}, status=${activeRun.status}). Wait for it to finish or cancel it.`,
    )
    this.name = 'RunConflictError'
  }
}

export class UnknownRunKindError extends Error {
  constructor(kind: string) {
    super(`Unknown run kind "${kind}"`)
    this.name = 'UnknownRunKindError'
  }
}

interface RunRecord {
  info: RunInfo
  definition: RunDefinition
  log: BoundedRunLog
  child: ChildProcess | null
  timeoutTimer: NodeJS.Timeout | null
  killTimer: NodeJS.Timeout | null
}

export interface RunSubscription {
  line?: (line: RunLogLine) => void
  update?: (info: RunInfo) => void
  end?: (info: RunInfo) => void
}

export interface RunManagerOptions {
  definitions: Record<string, RunDefinition>
  redactor: Redactor
  maxLogBytes: number
  maxRetained: number
  killGraceMs: number
}

const FINISHED: ReadonlySet<RunStatus> = new Set(['succeeded', 'failed', 'cancelled'])

export class RunManager {
  private readonly runs = new Map<string, RunRecord>()
  private readonly emitter = new EventEmitter()

  constructor(private readonly opts: RunManagerOptions) {
    // Listener count is bounded by open SSE connections (local, single user);
    // the default max-listener warning would only add noise.
    this.emitter.setMaxListeners(0)
  }

  start(kind: string): RunInfo {
    const definition = this.opts.definitions[kind]
    if (!definition) throw new UnknownRunKindError(kind)

    const active = this.findActiveInGroup(definition.mutexGroup)
    if (active) throw new RunConflictError(active)

    // Configuration gate: rejects before any record/process exists.
    definition.preflight?.()

    const now = new Date().toISOString()
    const record: RunRecord = {
      definition,
      log: new BoundedRunLog(this.opts.maxLogBytes),
      child: null,
      timeoutTimer: null,
      killTimer: null,
      info: {
        id: crypto.randomUUID(),
        kind: definition.kind,
        title: definition.title,
        status: 'queued',
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelRequested: false,
        error: null,
        logBytes: 0,
        logTruncatedHead: false,
      },
    }
    this.runs.set(record.info.id, record)
    try {
      this.launch(record)
    } catch (err) {
      // Unexpected launch failure (e.g. prompt file vanished between
      // preflight and build): record it as a failed run instead of leaving
      // a zombie 'queued' entry.
      record.info.error = err instanceof Error ? err.message : String(err)
      this.appendLine(record, 'system', `launch failed: ${record.info.error}`)
      this.finalize(record, null, null)
    }
    return this.snapshot(record)
  }

  list(): RunInfo[] {
    return [...this.runs.values()].map((r) => this.snapshot(r)).reverse()
  }

  get(id: string): RunInfo | null {
    const record = this.runs.get(id)
    return record ? this.snapshot(record) : null
  }

  getLogLines(id: string, sinceSeq = 0): RunLogLine[] | null {
    const record = this.runs.get(id)
    return record ? record.log.snapshot(sinceSeq) : null
  }

  /** Requests termination. The final state lands when the process exits. */
  cancel(id: string): RunInfo | null {
    const record = this.runs.get(id)
    if (!record) return null
    if (FINISHED.has(record.info.status)) return this.snapshot(record)

    record.info.cancelRequested = true
    this.appendLine(record, 'system', 'cancel requested by user — sending SIGTERM')
    this.emitUpdate(record)

    if (record.child && record.child.exitCode === null && !record.child.killed) {
      this.killChild(record)
    } else if (!record.child) {
      // Never spawned (defensive): finalize directly.
      this.finalize(record, null, null)
    }
    return this.snapshot(record)
  }

  /** Subscribe to a run's events. Returns an unsubscribe fn — always call it. */
  subscribe(id: string, handlers: RunSubscription): () => void {
    const onLine = (line: RunLogLine): void => handlers.line?.(line)
    const onUpdate = (info: RunInfo): void => handlers.update?.(info)
    const onEnd = (info: RunInfo): void => handlers.end?.(info)

    this.emitter.on(`line:${id}`, onLine)
    this.emitter.on(`update:${id}`, onUpdate)
    this.emitter.on(`end:${id}`, onEnd)

    return () => {
      this.emitter.off(`line:${id}`, onLine)
      this.emitter.off(`update:${id}`, onUpdate)
      this.emitter.off(`end:${id}`, onEnd)
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private findActiveInGroup(group: string): RunInfo | null {
    for (const record of this.runs.values()) {
      if (record.definition.mutexGroup === group && !FINISHED.has(record.info.status)) {
        return this.snapshot(record)
      }
    }
    return null
  }

  private launch(record: RunRecord): void {
    const { command, args, cwd, env, note } = record.definition.build()

    record.info.status = 'running'
    record.info.startedAt = new Date().toISOString()
    this.appendLine(record, 'system', `run started — kind=${record.definition.kind}`)
    // Provenance only (source path, length, tool scope) — never prompt content.
    if (note) this.appendLine(record, 'system', note)
    this.emitUpdate(record)

    // spawn with an argument array and no shell: nothing here is ever
    // interpreted by /bin/sh, so there is no injection surface.
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    record.child = child

    // Line-buffered ingestion: chunks accumulate until a newline, then each
    // complete line is redacted and stored/emitted. Buffering by line also
    // prevents a secret from escaping redaction by splitting across chunks.
    let stdoutRest = ''
    let stderrRest = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutRest = this.ingest(record, 'stdout', stdoutRest + chunk.toString('utf8'))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrRest = this.ingest(record, 'stderr', stderrRest + chunk.toString('utf8'))
    })

    child.on('error', (err) => {
      record.info.error = `spawn error: ${err.message}`
      this.appendLine(record, 'system', record.info.error)
      this.emitUpdate(record)
      // Node emits 'close' after 'error' even when the spawn itself failed,
      // so finalization happens exactly once, in the close handler.
    })

    child.on('close', (code, signal) => {
      if (stdoutRest !== '') this.appendLine(record, 'stdout', stdoutRest)
      if (stderrRest !== '') this.appendLine(record, 'stderr', stderrRest)
      stdoutRest = ''
      stderrRest = ''
      this.finalize(record, code, signal)
    })

    record.timeoutTimer = setTimeout(() => {
      record.info.timedOut = true
      this.appendLine(
        record,
        'system',
        `timeout after ${record.definition.timeoutMs}ms — sending SIGTERM`,
      )
      this.emitUpdate(record)
      this.killChild(record)
    }, record.definition.timeoutMs)
    record.timeoutTimer.unref()
  }

  /** Splits buffered text into complete lines; returns the trailing partial. */
  private ingest(record: RunRecord, stream: 'stdout' | 'stderr', buffered: string): string {
    const parts = buffered.split('\n')
    const rest = parts.pop() ?? ''
    for (const rawLine of parts) {
      this.appendLine(record, stream, rawLine.replace(/\r$/, ''))
    }
    return rest
  }

  private appendLine(record: RunRecord, stream: RunLogLine['stream'], rawText: string): void {
    // Redact BEFORE storing and BEFORE emitting — nothing unredacted survives.
    const line = record.log.append(stream, this.opts.redactor(rawText))
    record.info.logBytes = record.log.totalBytes
    record.info.logTruncatedHead = record.log.truncatedHead
    this.emitter.emit(`line:${record.info.id}`, line)
  }

  private killChild(record: RunRecord): void {
    const child = record.child
    if (!child || child.exitCode !== null) return
    child.kill('SIGTERM')
    if (!record.killTimer) {
      record.killTimer = setTimeout(() => {
        if (child.exitCode === null) {
          this.appendLine(record, 'system', 'process ignored SIGTERM — sending SIGKILL')
          child.kill('SIGKILL')
        }
      }, this.opts.killGraceMs)
      record.killTimer.unref()
    }
  }

  private finalize(record: RunRecord, code: number | null, signal: NodeJS.Signals | null): void {
    if (FINISHED.has(record.info.status)) return

    if (record.timeoutTimer) clearTimeout(record.timeoutTimer)
    if (record.killTimer) clearTimeout(record.killTimer)
    record.timeoutTimer = null
    record.killTimer = null

    const info = record.info
    info.exitCode = code
    info.signal = signal
    info.finishedAt = new Date().toISOString()
    info.durationMs = info.startedAt
      ? new Date(info.finishedAt).getTime() - new Date(info.startedAt).getTime()
      : null

    if (info.cancelRequested) {
      info.status = 'cancelled'
      info.error ??= 'cancelled by user'
    } else if (info.timedOut) {
      info.status = 'failed'
      info.error ??= `timed out after ${record.definition.timeoutMs}ms`
    } else if (info.error !== null) {
      info.status = 'failed' // spawn error already recorded
    } else if (code === 0) {
      info.status = 'succeeded'
    } else {
      info.status = 'failed'
      info.error = signal ? `terminated by signal ${signal}` : `exit code ${String(code)}`
    }

    this.appendLine(
      record,
      'system',
      `run finished — status=${info.status}` +
        (code !== null ? ` exit=${code}` : '') +
        (signal ? ` signal=${signal}` : '') +
        (info.durationMs !== null ? ` duration=${info.durationMs}ms` : ''),
    )
    this.emitUpdate(record)
    this.emitter.emit(`end:${info.id}`, this.snapshot(record))
    record.child = null
    this.prune()
  }

  /** Keeps at most `maxRetained` finished runs in memory; active runs never pruned. */
  private prune(): void {
    const finishedIds = [...this.runs.entries()]
      .filter(([, r]) => FINISHED.has(r.info.status))
      .map(([id]) => id)
    const excess = finishedIds.length - this.opts.maxRetained
    for (let i = 0; i < excess; i++) {
      const id = finishedIds[i]
      if (id !== undefined) this.runs.delete(id)
    }
  }

  private emitUpdate(record: RunRecord): void {
    this.emitter.emit(`update:${record.info.id}`, this.snapshot(record))
  }

  private snapshot(record: RunRecord): RunInfo {
    return { ...record.info }
  }
}
