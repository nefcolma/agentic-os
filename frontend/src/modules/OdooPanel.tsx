import { useApiGet } from '../lib/api'
import type {
  OdooEnvelope,
  InventoryRow,
  InventorySummary,
  TopClientRow,
  TopClientSummary,
  DecliningClientRow,
  DecliningSummary,
  OverdueInvoiceRow,
  OverdueSummary,
} from '../lib/types'
import { Panel, Pill } from '../components/ui'
import type { PillTone } from '../components/ui'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'

const REFRESH_MS = 300_000 // read-only auto-refresh every 5 min

const usd = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

/** Maps an Odoo envelope's status to a header pill. */
function statusPill<TRow, TSummary>(
  state: ReturnType<typeof useApiGet<OdooEnvelope<TRow, TSummary>>>,
): { tone: PillTone; label: string } {
  if (state.status === 'loading') return { tone: 'amber', label: 'Reading' }
  if (state.status === 'error') return { tone: 'red', label: 'Error' }
  if (state.data.status === 'not_configured') return { tone: 'neutral', label: 'Not configured' }
  if (state.data.status === 'error') return { tone: 'red', label: 'Unavailable' }
  return { tone: 'green', label: 'Live' }
}

function Stat({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: PillTone }) {
  const color =
    tone === 'red'
      ? 'text-red-400'
      : tone === 'amber'
        ? 'text-amber-400'
        : tone === 'green'
          ? 'text-emerald-400'
          : 'text-neutral-100'
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2">
      <div className={`font-mono text-lg font-bold ${color}`}>{value}</div>
      <div className="mt-0.5 font-mono text-[10px] tracking-[0.15em] text-neutral-500 uppercase">{label}</div>
    </div>
  )
}

/** Shared body wrapper: renders loading/error/not-configured, else the children. */
function OdooBody<TRow, TSummary>({
  state,
  children,
}: {
  state: ReturnType<typeof useApiGet<OdooEnvelope<TRow, TSummary>>>
  children: (data: OdooEnvelope<TRow, TSummary>) => React.ReactNode
}) {
  if (state.status === 'loading')
    return <p className="font-mono text-xs text-neutral-500">Pulling from Odoo (read-only)…</p>
  if (state.status === 'error')
    return <p className="font-mono text-xs text-red-400">{state.message}</p>
  const data = state.data
  if (data.status === 'not_configured')
    return (
      <div className="space-y-1">
        <p className="font-mono text-xs text-neutral-500">Odoo is not configured on this machine.</p>
        <ul className="font-mono text-[10px] text-neutral-600">
          {(data.missing ?? []).map((m) => (
            <li key={m}>· missing: {m}</li>
          ))}
        </ul>
      </div>
    )
  if (data.status === 'error')
    return <p className="font-mono text-xs text-red-400">Odoo unavailable: {data.message}</p>
  return <>{children(data)}</>
}

function PulledAt({ iso }: { iso: string }) {
  return (
    <p className="mt-2 font-mono text-[10px] text-neutral-600">
      pulled {new Date(iso).toLocaleString()} · read-only search_read
    </p>
  )
}

function InventoryCard() {
  const state = useApiGet<OdooEnvelope<InventoryRow, InventorySummary>>(
    '/api/odoo/inventory?product=walnut&limit=100',
    REFRESH_MS,
  )
  return (
    <Panel title="Inventory · walnut" pill={statusPill(state)}>
      <OdooBody state={state}>
        {(data) => (
          <div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Lines" value={String(data.summary?.lines ?? 0)} />
              <Stat label="On hand" value={String(data.summary?.totalQuantity ?? 0)} />
              <Stat
                label="Out of stock"
                value={String(data.summary?.outOfStock ?? 0)}
                tone={data.summary && data.summary.outOfStock > 0 ? 'red' : 'neutral'}
              />
              <Stat
                label="Low stock"
                value={String(data.summary?.lowStock ?? 0)}
                tone={data.summary && data.summary.lowStock > 0 ? 'amber' : 'neutral'}
              />
            </div>
            {data.count > 0 && (
              <ul className="mt-3 max-h-44 overflow-auto rounded-md border border-neutral-800">
                {data.rows.slice(0, 12).map((r, i) => (
                  <li
                    key={`${r.productId}-${i}`}
                    className="flex items-center justify-between gap-2 border-b border-neutral-800/60 px-3 py-1.5 last:border-b-0"
                  >
                    <span className="truncate text-[11px] text-neutral-300" title={r.product}>
                      {r.product || '(unnamed)'}
                    </span>
                    <span
                      className={`shrink-0 font-mono text-[11px] ${r.quantity <= 0 ? 'text-red-400' : 'text-neutral-300'}`}
                    >
                      {r.quantity}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <PulledAt iso={data.pulledAt} />
          </div>
        )}
      </OdooBody>
    </Panel>
  )
}

function TopClientsCard() {
  const state = useApiGet<OdooEnvelope<TopClientRow, TopClientSummary>>(
    '/api/odoo/top-clients?days=30&limit=8',
    REFRESH_MS,
  )
  return (
    <Panel title="Top clients · 30d" pill={statusPill(state)}>
      <OdooBody state={state}>
        {(data) => (
          <div>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Clients" value={String(data.summary?.clients ?? 0)} />
              <Stat label="Revenue" value={usd(data.summary?.totalRevenue ?? 0)} tone="green" />
            </div>
            {data.count > 0 && (
              <div className="mt-3 h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.rows} layout="vertical" margin={{ left: 8, right: 16 }}>
                    <XAxis type="number" hide />
                    <YAxis
                      type="category"
                      dataKey="partner"
                      width={110}
                      tick={{ fill: '#a3a3a3', fontSize: 10, fontFamily: 'monospace' }}
                      tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)}
                    />
                    <Tooltip
                      cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                      contentStyle={{
                        background: '#0a0a0a',
                        border: '1px solid #262626',
                        borderRadius: 8,
                        fontFamily: 'monospace',
                        fontSize: 11,
                      }}
                      formatter={(value) => [usd(Number(value)), 'revenue']}
                    />
                    <Bar dataKey="revenue" radius={[0, 3, 3, 0]}>
                      {data.rows.map((_, i) => (
                        <Cell key={i} fill="#d29a63" />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            <PulledAt iso={data.pulledAt} />
          </div>
        )}
      </OdooBody>
    </Panel>
  )
}

function DecliningClientsCard() {
  const state = useApiGet<OdooEnvelope<DecliningClientRow, DecliningSummary>>(
    '/api/odoo/declining-clients?days=90&minOrders=5&businessOnly=true&limit=8',
    REFRESH_MS,
  )
  return (
    <Panel title="Declining accounts · 90d" pill={statusPill(state)}>
      <OdooBody state={state}>
        {(data) => (
          <div>
            <div className="grid grid-cols-2 gap-2">
              <Stat
                label="At risk"
                value={String(data.summary?.count ?? 0)}
                tone={data.summary && data.summary.count > 0 ? 'amber' : 'green'}
              />
              <Stat label="Avg drop" value={`${data.summary?.avgDropPct ?? 0}%`} />
            </div>
            {data.count === 0 ? (
              <p className="mt-3 font-mono text-xs text-emerald-400">
                No declining recurring accounts detected.
              </p>
            ) : (
              <ul className="mt-3 max-h-44 overflow-auto rounded-md border border-neutral-800">
                {data.rows.map((r, i) => (
                  <li
                    key={`${r.partnerId}-${i}`}
                    className="flex items-center justify-between gap-2 border-b border-neutral-800/60 px-3 py-1.5 last:border-b-0"
                  >
                    <span className="truncate text-[11px] text-neutral-300" title={r.partner}>
                      {r.partner || '(unnamed)'}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-amber-400">−{r.dropPct}%</span>
                  </li>
                ))}
              </ul>
            )}
            <PulledAt iso={data.pulledAt} />
          </div>
        )}
      </OdooBody>
    </Panel>
  )
}

function OverdueInvoicesCard() {
  const state = useApiGet<OdooEnvelope<OverdueInvoiceRow, OverdueSummary>>(
    '/api/odoo/overdue-invoices?limit=50',
    REFRESH_MS,
  )
  return (
    <Panel title="Overdue invoices" pill={statusPill(state)}>
      <OdooBody state={state}>
        {(data) => (
          <div>
            <div className="grid grid-cols-2 gap-2">
              <Stat
                label="Overdue"
                value={String(data.summary?.count ?? 0)}
                tone={data.summary && data.summary.count > 0 ? 'red' : 'green'}
              />
              <Stat label="Total due" value={usd(data.summary?.totalOverdue ?? 0)} tone="red" />
            </div>
            {data.count === 0 ? (
              <p className="mt-3 font-mono text-xs text-emerald-400">No overdue invoices.</p>
            ) : (
              <ul className="mt-3 max-h-44 overflow-auto rounded-md border border-neutral-800">
                {data.rows.slice(0, 12).map((r) => (
                  <li
                    key={r.invoice}
                    className="flex items-center justify-between gap-2 border-b border-neutral-800/60 px-3 py-1.5 last:border-b-0"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[11px] text-neutral-300" title={r.partner}>
                        {r.partner || '(unnamed)'}
                      </span>
                      <span className="block font-mono text-[10px] text-neutral-600">
                        {r.invoice} · due {r.dueDate ?? '—'}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-red-400">{usd(r.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
            <PulledAt iso={data.pulledAt} />
          </div>
        )}
      </OdooBody>
    </Panel>
  )
}

export function OdooPanel() {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="font-mono text-xs font-semibold tracking-[0.2em] text-neutral-400 uppercase">
          Odoo · read-only
        </h2>
        <Pill tone="green" label="Live data" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <InventoryCard />
        <TopClientsCard />
        <DecliningClientsCard />
        <OverdueInvoicesCard />
      </div>
    </section>
  )
}
