import type { ReactNode } from 'react'

/**
 * Minimal, dependency-free markdown renderer for the document modal.
 * Handles headings, bullet/numbered lists, hr, blank-line paragraphs, and
 * inline **bold** + `code`. Not a full CommonMark parser — enough to render
 * the vault/Drive notes cleanly in the command-center theme.
 */

function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = []
  // Split on **bold** and `code`, keeping delimiters.
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  parts.forEach((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      nodes.push(
        <strong key={`${keyBase}-b${i}`} className="font-semibold text-neutral-100">
          {part.slice(2, -2)}
        </strong>,
      )
    } else if (/^`[^`]+`$/.test(part)) {
      nodes.push(
        <code key={`${keyBase}-c${i}`} className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[0.85em] text-copper-300">
          {part.slice(1, -1)}
        </code>,
      )
    } else if (part) {
      nodes.push(part)
    }
  })
  return nodes
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null

  const flushList = (key: string): void => {
    if (!list) return
    const items = list.items.map((it, i) => (
      <li key={`${key}-li${i}`} className="ml-4 list-disc text-neutral-300 marker:text-neutral-600">
        {renderInline(it, `${key}-li${i}`)}
      </li>
    ))
    blocks.push(
      list.ordered ? (
        <ol key={key} className="my-2 space-y-1 pl-4">
          {items}
        </ol>
      ) : (
        <ul key={key} className="my-2 space-y-1 pl-4">
          {items}
        </ul>
      ),
    )
    list = null
  }

  lines.forEach((raw, idx) => {
    const line = raw.trimEnd()
    const key = `md-${idx}`
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    const numbered = /^\d+\.\s+(.*)$/.exec(line)

    if (heading) {
      flushList(`${key}-l`)
      const level = heading[1]!.length
      const cls =
        level <= 1
          ? 'mt-4 mb-2 font-mono text-sm font-bold tracking-wide text-neutral-100'
          : level === 2
            ? 'mt-3 mb-1.5 font-mono text-xs font-semibold tracking-wide text-copper-300 uppercase'
            : 'mt-2 mb-1 font-mono text-[11px] font-semibold tracking-wider text-neutral-400 uppercase'
      blocks.push(
        <div key={key} className={cls}>
          {renderInline(heading[2]!, key)}
        </div>,
      )
    } else if (/^---+$/.test(line)) {
      flushList(`${key}-l`)
      blocks.push(<hr key={key} className="my-3 border-neutral-800" />)
    } else if (bullet) {
      if (!list || list.ordered) {
        flushList(`${key}-l`)
        list = { ordered: false, items: [] }
      }
      list.items.push(bullet[1]!)
    } else if (numbered) {
      if (!list || !list.ordered) {
        flushList(`${key}-l`)
        list = { ordered: true, items: [] }
      }
      list.items.push(numbered[1]!)
    } else if (line === '') {
      flushList(`${key}-l`)
    } else {
      flushList(`${key}-l`)
      blocks.push(
        <p key={key} className="my-1.5 text-[13px] leading-relaxed text-neutral-300">
          {renderInline(line, key)}
        </p>,
      )
    }
  })
  flushList('md-end')

  return <div>{blocks}</div>
}
