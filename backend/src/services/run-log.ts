export type RunLogStream = 'stdout' | 'stderr' | 'system'

export interface RunLogLine {
  /** Monotonic per-run sequence — lets SSE clients resume via Last-Event-ID. */
  seq: number
  stream: RunLogStream
  text: string
  at: string
}

/** A single log line longer than this gets cut — protects memory and SSE frames. */
const MAX_LINE_BYTES = 16_384

/**
 * In-memory, byte-bounded log for one run. When the cap is exceeded the
 * OLDEST lines are evicted (tail is what the user needs) and the loss is
 * marked with `truncatedHead`. Text must arrive already redacted.
 */
export class BoundedRunLog {
  private lines: RunLogLine[] = []
  private bytes = 0
  private nextSeq = 1
  truncatedHead = false

  constructor(private readonly maxBytes: number) {}

  append(stream: RunLogStream, text: string): RunLogLine {
    let stored = text
    if (Buffer.byteLength(stored, 'utf8') > MAX_LINE_BYTES) {
      stored = `${stored.slice(0, MAX_LINE_BYTES)}… [line truncated]`
    }
    const line: RunLogLine = {
      seq: this.nextSeq++,
      stream,
      text: stored,
      at: new Date().toISOString(),
    }
    this.lines.push(line)
    this.bytes += Buffer.byteLength(stored, 'utf8')

    while (this.bytes > this.maxBytes && this.lines.length > 1) {
      const evicted = this.lines.shift()
      if (evicted) {
        this.bytes -= Buffer.byteLength(evicted.text, 'utf8')
        this.truncatedHead = true
      }
    }
    return line
  }

  /** Lines with seq greater than `sinceSeq` (0 = everything retained). */
  snapshot(sinceSeq = 0): RunLogLine[] {
    return sinceSeq === 0 ? [...this.lines] : this.lines.filter((l) => l.seq > sinceSeq)
  }

  get totalBytes(): number {
    return this.bytes
  }
}
