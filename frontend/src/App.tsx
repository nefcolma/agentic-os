import { useState } from 'react'
import { Gauge, Network, Zap, Database, ShieldCheck, FileText, Settings } from 'lucide-react'
import { useApiGet } from './lib/api'
import type { HealthResponse, VaultSummary } from './lib/types'
import { Panel, Pill, KeyValue } from './components/ui'
import { Shell } from './components/Shell'
import type { NavItem } from './components/Shell'
import { VaultPanel } from './modules/VaultPanel'
import { NightlyLogPanel } from './modules/NightlyLogPanel'
import { RunLogPanel } from './modules/RunLogPanel'
import { ActionsPanel } from './modules/ActionsPanel'
import { OdooPanel } from './modules/OdooPanel'
import { KnowledgePanel } from './modules/KnowledgePanel'
import { QualityPanel } from './modules/QualityPanel'
import { KnowledgeMap } from './modules/KnowledgeMap'
import { SessionProvider, useSession } from './lib/session'
import { SettingsPanel } from './modules/SettingsPanel'

const NAV: NavItem[] = [
  { id: 'command', label: 'Command', icon: Gauge },
  { id: 'map', label: 'Knowledge Map', icon: Network },
  { id: 'actions', label: 'Actions', icon: Zap },
  { id: 'odoo', label: 'Odoo', icon: Database },
  { id: 'quality', label: 'Data Quality', icon: ShieldCheck },
  { id: 'knowledge', label: 'Knowledge', icon: FileText },
  { id: 'settings', label: 'Settings', icon: Settings },
]

function SystemCard({ health }: { health: ReturnType<typeof useApiGet<HealthResponse>> }) {
  const pill =
    health.status === 'loading'
      ? ({ tone: 'amber', label: 'Checking' } as const)
      : health.status === 'success'
        ? ({ tone: 'green', label: 'Live' } as const)
        : ({ tone: 'red', label: 'Offline' } as const)
  return (
    <Panel title="System" pill={pill}>
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
              <Pill tone={health.data.vault.exists ? 'green' : 'red'} label={health.data.vault.exists ? 'Found' : 'Missing'} />
            </span>
          </KeyValue>
          <KeyValue label="Bind">127.0.0.1 · loopback only</KeyValue>
        </div>
      )}
    </Panel>
  )
}

function Container({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return <div className={`mx-auto ${wide ? 'max-w-7xl' : 'max-w-6xl'} space-y-4 p-5`}>{children}</div>
}

function Dashboard() {
  const session = useSession()
  const [view, setView] = useState('command')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const health = useApiGet<HealthResponse>('/api/health', 15_000)
  const vault = useApiGet<VaultSummary>('/api/vault-summary', 60_000)

  const systemPill =
    health.status === 'loading'
      ? { tone: 'amber' as const, label: 'Checking' }
      : health.status === 'success'
        ? { tone: 'green' as const, label: 'Live' }
        : { tone: 'red' as const, label: 'Offline' }

  const status = (
    <>
      {vault.status === 'success' && (
        <span className="hidden font-mono text-[10px] tracking-wider text-neutral-500 uppercase md:inline">
          {vault.data.folders.projects.count} proj · {vault.data.folders.areas.count} areas ·{' '}
          {vault.data.folders.inbox.count} inbox
        </span>
      )}
      {!session.canWrite && <Pill tone="copper" label="Read-only" />}
      {session.email && (
        <span className="hidden font-mono text-[10px] text-neutral-500 lg:inline">{session.email}</span>
      )}
      <span className="font-mono text-[10px] tracking-wider text-neutral-500 uppercase">System</span>
      <Pill tone={systemPill.tone} label={systemPill.label} />
    </>
  )

  return (
    <Shell version="OS 0.1" status={status} nav={NAV} active={view} onNavigate={setView}>
      {view === 'command' && (
        <Container>
          <SystemCard health={health} />
          <VaultPanel />
          <NightlyLogPanel />
        </Container>
      )}

      {view === 'map' && (
        <Container wide>
          <KnowledgeMap />
        </Container>
      )}

      {view === 'actions' && (
        <Container>
          <div className="grid gap-4 lg:grid-cols-2">
            <ActionsPanel onRunStarted={(run) => setSelectedRunId(run.id)} />
            <RunLogPanel selectedRunId={selectedRunId} onSelectRun={setSelectedRunId} />
          </div>
        </Container>
      )}

      {view === 'odoo' && (
        <Container wide>
          <OdooPanel />
        </Container>
      )}

      {view === 'quality' && (
        <Container>
          <QualityPanel />
        </Container>
      )}

      {view === 'knowledge' && (
        <Container>
          <KnowledgePanel />
        </Container>
      )}

      {view === 'settings' && (
        <Container>
          <SettingsPanel />
        </Container>
      )}
    </Shell>
  )
}

export default function App() {
  return (
    <SessionProvider>
      <Dashboard />
    </SessionProvider>
  )
}
