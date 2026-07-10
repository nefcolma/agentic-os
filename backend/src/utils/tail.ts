import fs from 'node:fs/promises'

export interface TailResult {
  lines: string[]
  /** True when older content exists beyond what was returned. */
  truncated: boolean
  sizeBytes: number
  modifiedAt: string
}

/**
 * Returns the last `maxLines` lines of a file without loading more than
 * `maxBytes` of it. Returns null when the file does not exist.
 */
export async function tailFile(
  filePath: string,
  maxLines: number,
  maxBytes = 1_048_576,
): Promise<TailResult | null> {
  let handle
  try {
    handle = await fs.open(filePath, 'r')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }

  try {
    const stat = await handle.stat()
    const readBytes = Math.min(stat.size, maxBytes)
    const position = stat.size - readBytes
    const buffer = Buffer.alloc(readBytes)
    await handle.read(buffer, 0, readBytes, position)

    let lines = buffer.toString('utf8').split('\n')
    // Reading from a mid-file offset leaves a partial first line — drop it.
    if (position > 0) lines = lines.slice(1)
    // Trailing newline produces one empty final element — drop it.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines = lines.slice(0, -1)

    const truncated = position > 0 || lines.length > maxLines
    return {
      lines: lines.slice(-maxLines),
      truncated,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    }
  } finally {
    await handle.close()
  }
}
