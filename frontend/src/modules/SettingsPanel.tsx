import { useEffect, useState } from 'react'
import { apiGet, apiPost, ApiError } from '../lib/api'
import type { VaultConfigResponse, VaultDetectResponse, VaultStatus } from '../lib/types'
import { Panel, Pill } from '../components/ui'
import { useSession } from '../lib/session'

const SOURCE_LABEL: Record<string, string> = {
  user: 'connected by you',
  env: 'from MYBRAIN_VAULT_PATH',
  default: 'default location',
}

function StatusLine({ status }: { status: VaultStatus }) {
  const ok = status.exists && status.isDirectory && status.looksLikeVault
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={ok ? 'green' : 'red'} label={ok ? 'Valid vault' : 'Not usable'} />
        {status.hasObsidian && <Pill tone="copper" label="Obsidian" />}
        {status.hasClaudeDir && <Pill tone="neutral" label=".claude" />}
        <span className="font-mono text-[10px] text-neutral-500">{status.markdownCount}+ notes</span>
      </div>
      <p className="font-mono text-[11px] break-all text-neutral-300">{status.path}</p>
      {status.folders.length > 0 && (
        <p className="font-mono text-[10px] text-neutral-600">folders: {status.folders.join(' · ')}</p>
      )}
      {status.problem && <p className="font-mono text-[11px] text-red-400">{status.problem}</p>}
    </div>
  )
}

export function SettingsPanel() {
  const [config, setConfig] = useState<VaultConfigResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<VaultStatus[]>([])
  const [input, setInput] = useState('')
  const [checked, setChecked] = useState<VaultStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const { canWrite } = useSession()

  useEffect(() => {
    void (async () => {
      try {
        const c = await apiGet<VaultConfigResponse>('/api/vault/config')
        setConfig(c)
        setInput(c.status.path)
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e))
      }
      try {
        const d = await apiGet<VaultDetectResponse>('/api/vault/detect')
        setCandidates(d.candidates)
      } catch {
        // detection is best-effort
      }
    })()
  }, [])

  async function check(p: string): Promise<void> {
    setMessage(null)
    try {
      const r = await apiGet<{ status: VaultStatus }>(`/api/vault/inspect?path=${encodeURIComponent(p)}`)
      setChecked(r.status)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    }
  }

  async function connect(p: string): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      await apiPost<VaultConfigResponse>('/api/vault/config', { path: p })
      setMessage('Vault connected — reloading the dashboard…')
      // Every panel derives from the vault; a reload re-fetches them all cleanly.
      setTimeout(() => window.location.reload(), 700)
    } catch (e) {
      setMessage(
        e instanceof ApiError && e.code === 'INVALID_VAULT'
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e),
      )
      setBusy(false)
    }
  }

  async function reset(): Promise<void> {
    setBusy(true)
    try {
      await apiPost<VaultConfigResponse>('/api/vault/config/reset')
      setMessage('Reset to the default vault — reloading…')
      setTimeout(() => window.location.reload(), 700)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <Panel
        title="Connected vault"
        pill={
          config
            ? config.status.problem
              ? { tone: 'red', label: 'Problem' }
              : { tone: 'green', label: 'Connected' }
            : { tone: 'amber', label: 'Loading' }
        }
      >
        {loadError && <p className="font-mono text-xs text-red-400">{loadError}</p>}
        {config && (
          <div className="space-y-3">
            <StatusLine status={config.status} />
            <p className="font-mono text-[10px] tracking-wider text-neutral-600 uppercase">
              source: {SOURCE_LABEL[config.source] ?? config.source}
            </p>
            {config.source === 'user' && (
              <button
                type="button"
                disabled={busy || !canWrite}
                onClick={() => void reset()}
                className="rounded border border-neutral-700 px-2 py-1 font-mono text-[10px] tracking-wider text-neutral-400 uppercase hover:bg-neutral-800 disabled:opacity-40"
              >
                Reset to default
              </button>
            )}
          </div>
        )}
      </Panel>

      <Panel title="Connect a different vault" pill={{ tone: 'copper', label: 'Per user' }}>
        <div className="space-y-3">
          <p className="text-[11px] leading-relaxed text-neutral-400">
            Point the dashboard at any Obsidian vault or notes folder on this computer. Everything —
            vault summary, actions, knowledge, Regenerate — follows the folder you connect here. The
            choice is saved locally on this machine.
          </p>

          <div className="flex flex-wrap gap-2">
            <input
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                setChecked(null)
              }}
              spellCheck={false}
              placeholder="/Users/you/Documents/MyVault"
              className="min-w-0 grow rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-[11px] text-neutral-200 outline-none focus:border-copper-500/50"
            />
            <button
              type="button"
              onClick={() => void check(input)}
              className="rounded border border-neutral-700 px-3 py-1 font-mono text-[10px] tracking-wider text-neutral-300 uppercase hover:bg-neutral-800"
            >
              Check
            </button>
            <button
              type="button"
              disabled={busy || !canWrite || input.trim() === ''}
              onClick={() => void connect(input)}
              className="rounded border border-copper-500/50 bg-copper-500/10 px-3 py-1 font-mono text-[10px] tracking-wider text-copper-300 uppercase hover:bg-copper-500/20 disabled:opacity-40"
            >
              Connect
            </button>
          </div>

          {checked && (
            <div className="rounded-md border border-neutral-800 bg-neutral-900/40 p-3">
              <StatusLine status={checked} />
            </div>
          )}
          {message && <p className="font-mono text-[11px] text-amber-400">{message}</p>}

          {candidates.length > 0 && (
            <div>
              <p className="mb-1.5 font-mono text-[10px] tracking-[0.2em] text-neutral-500 uppercase">
                Detected on this machine
              </p>
              <div className="space-y-1.5">
                {candidates.map((c) => (
                  <div
                    key={c.path}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-[11px] text-neutral-200">
                        {c.path.split('/').pop()}
                      </span>
                      <span className="block truncate font-mono text-[10px] text-neutral-600">{c.path}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {c.hasObsidian && <Pill tone="copper" label="Obsidian" />}
                      <button
                        type="button"
                        disabled={busy || !canWrite}
                        onClick={() => void connect(c.path)}
                        className="rounded border border-neutral-700 px-2 py-1 font-mono text-[10px] tracking-wider text-neutral-300 uppercase hover:bg-neutral-800 disabled:opacity-40"
                      >
                        Use
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Panel>
    </div>
  )
}
