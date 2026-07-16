export interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
}

/**
 * LCS-based line diff. Notes are small, so the O(n·m) table is fine; for
 * anything unexpectedly large we bail to a coarse replace-all diff.
 */
export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.replace(/\r\n/g, '\n').split('\n')
  const B = b.replace(/\r\n/g, '\n').split('\n')
  const n = A.length
  const m = B.length

  if (n * m > 4_000_000) {
    return [...A.map((t) => ({ type: 'del' as const, text: t })), ...B.map((t) => ({ type: 'add' as const, text: t }))]
  }

  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ type: 'same', text: A[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'del', text: A[i]! })
      i++
    } else {
      out.push({ type: 'add', text: B[j]! })
      j++
    }
  }
  while (i < n) out.push({ type: 'del', text: A[i++]! })
  while (j < m) out.push({ type: 'add', text: B[j++]! })
  return out
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((l) => l.type === 'add').length,
    removed: lines.filter((l) => l.type === 'del').length,
  }
}
