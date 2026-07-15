import { useState } from 'react'
import { useApiGet } from './lib/api'
import type { HealthResponse } from './lib/types'
import { Panel, Pill, KeyValue } from './components/ui'
import { VaultPanel } from './modules/VaultPanel'
import { NightlyLogPanel } from './modules/NightlyLogPanel'
import { RunLogPanel } from './modules/RunLogPanel'
import { ActionsPanel } from './modules/ActionsPanel'
import { OdooPanel } from './modules/OdooPanel'
import { KnowledgePanel } from './modules/KnowledgePanel'
import { QualityPanel } from './modules/QualityPanel'

export default function App() {
  const health = useApiGet<HealthResponse>('/api/health', 15_000)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)

  const systemPill =
    health.status === 'loading'
      ? { tone: 'amber' as const, label: 'Checking' }
      : health.status === 'success'
        ? { tone: 'green' as const, label: 'Live' }
        : { tone: 'red' as const, label: 'Offline' }

  return (
    <div className="min-h-screen">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 px-6 py-4">
        <div>
          <h1 className="font-mono text-sm font-bold tracking-[0.3em] text-neutral-100 uppercase">
            MyBrain <span className="text-copper-400">Agentic OS</span>
          </h1>
          <p className="mt-1 font-mono text-[11px] tracking-wider text-neutral-500">
            LOCAL COMMAND CENTER · 127.0.0.1 · SINGLE USER
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] tracking-wider text-neutral-500 uppercase">System</span>
          <Pill tone={systemPill.tone} label={systemPill.label} />
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-4 p-6">
        <Panel title="Backend" pill={systemPill}>
          {health.status === 'loading' && (
            <p className="font-mono text-xs text-neutral-500">Querying http://127.0.0.1 backend…</p>
          )}
          {health.status === 'error' && (
            <div className="space-y-1">
              <p className="font-mono text-xs text-red-400">Backend unreachable: {health.message}</p>
              <p className="font-mono text-[11px] text-neutral-500">
                Run <span className="text-neutral-300">npm run dev</span> and check the api process output.
              </p>
            </div>
          )}
          {health.status === 'success' && (
            <div>
              <KeyValue label="Service">
                {health.data.service} v{health.data.version}
              </KeyValue>
              <KeyValue label="Uptime">{health.data.uptimeSeconds}s</KeyValue>
              <KeyValue label="Vault path">
                <span className="inline-flex flex-wrap items-center justify-end gap-2">
                  <span className="break-all text-neutral-400">{health.data.vault.path}</span>
                  <Pill
                    tone={health.data.vault.exists ? 'green' : 'red'}
                    label={health.data.vault.exists ? 'Found' : 'Missing'}
                  />
                </span>
              </KeyValue>
              <KeyValue label="Last check">{new Date(health.data.timestamp).toLocaleTimeString()}</KeyValue>
            </div>
          )}
        </Panel>

        <VaultPanel />

        <div className="grid gap-4 lg:grid-cols-2">
          <ActionsPanel onRunStarted={(run) => setSelectedRunId(run.id)} />
          <RunLogPanel selectedRunId={selectedRunId} onSelectRun={setSelectedRunId} />
        </div>

        <OdooPanel />

        <QualityPanel />

        <KnowledgePanel />

        <div className="grid gap-4">
          <NightlyLogPanel />
        </div>
      </main>
    </div>
  )
}
