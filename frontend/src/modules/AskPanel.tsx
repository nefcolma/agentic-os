import { useEffect, useRef, useState } from 'react'
import { apiPost, ApiError } from '../lib/api'
import { Markdown } from '../lib/markdown'
import { useSession } from '../lib/session'
import { Pill } from '../components/ui'

interface Msg {
  role: 'user' | 'assistant' | 'error'
  text: string
  generatedBy?: string
}

interface AskResponse {
  result: { answer: string; generatedBy: string }
}

export function AskPanel() {
  const { canWrite } = useSession()
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
  }, [messages, busy])

  async function send(): Promise<void> {
    const question = input.trim()
    if (question === '' || busy) return
    setInput('')
    setMessages((m) => [...m, { role: 'user', text: question }])
    setBusy(true)
    try {
      const r = await apiPost<AskResponse>('/api/ask', { question })
      setMessages((m) => [...m, { role: 'assistant', text: r.result.answer, generatedBy: r.result.generatedBy }])
    } catch (e) {
      const msg =
        e instanceof ApiError && e.code === 'CLI_FAILED'
          ? `${e.message} — ¿el CLI de Claude está autenticado? (corre \`claude auth login\`)`
          : e instanceof ApiError && e.code === 'READ_ONLY'
            ? 'Ask está reservado a administradores (consume la suscripción de Claude del dueño).'
            : e instanceof Error
              ? e.message
              : String(e)
      setMessages((m) => [...m, { role: 'error', text: msg }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex h-[calc(100vh-8rem)] flex-col rounded-lg border border-neutral-800 bg-neutral-950/70">
      <header className="flex items-center justify-between gap-2 border-b border-neutral-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-semibold tracking-[0.25em] text-neutral-300 lowercase">
            brain<span className="text-copper-400">://ask</span>
          </span>
          <Pill tone="green" label="Read-only" />
        </div>
        <span className="hidden font-mono text-[10px] tracking-wider text-neutral-600 sm:inline">
          grounded in your vault + live Odoo
        </span>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="mx-auto max-w-lg pt-10 text-center">
            <p className="font-mono text-sm text-neutral-400">Ask the brain about your vault or business.</p>
            <p className="mt-2 font-mono text-[11px] leading-relaxed text-neutral-600">
              e.g. “how many walnut urns are in stock?” · “which projects are active?” ·
              “any overdue invoices this week?”
            </p>
            <p className="mt-3 font-mono text-[10px] text-neutral-700">
              Reads only. Claude answers from your notes and read-only Odoo pulls — it never writes.
            </p>
          </div>
        )}

        {messages.map((m, i) => {
          if (m.role === 'user') {
            return (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] rounded-lg border border-neutral-800 bg-neutral-900/70 px-3 py-2 font-mono text-[13px] text-neutral-200">
                  <span className="text-copper-400">›</span> {m.text}
                </div>
              </div>
            )
          }
          if (m.role === 'error') {
            return (
              <div key={i} className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2">
                <p className="font-mono text-xs text-red-400">{m.text}</p>
              </div>
            )
          }
          return (
            <div key={i} className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3">
              <Markdown text={m.text} />
              {m.generatedBy && (
                <p className="mt-2 font-mono text-[10px] text-neutral-600">{m.generatedBy}</p>
              )}
            </div>
          )
        })}

        {busy && (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3">
            <p className="font-mono text-xs text-neutral-500">
              Thinking via <span className="text-copper-300">claude -p</span> (read-only)… this can take a moment.
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-neutral-800 p-3">
        {canWrite ? (
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              rows={1}
              disabled={busy}
              placeholder="Ask the brain…  (Enter to send, Shift+Enter for newline)"
              className="max-h-32 min-h-9 grow resize-none rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-[13px] text-neutral-200 outline-none focus:border-copper-500/50 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={busy || input.trim() === ''}
              className="rounded-md border border-copper-500/50 bg-copper-500/10 px-4 py-2 font-mono text-[11px] tracking-widest text-copper-300 uppercase hover:bg-copper-500/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send
            </button>
          </div>
        ) : (
          <p className="px-1 font-mono text-[11px] text-neutral-600">
            Ask is admin-only — it runs on the vault owner's Claude subscription.
          </p>
        )}
      </div>
    </section>
  )
}
