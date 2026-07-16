import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export interface NavItem {
  id: string
  label: string
  icon: LucideIcon
}

export function Shell({
  version,
  status,
  nav,
  active,
  onNavigate,
  children,
}: {
  version: string
  status: ReactNode
  nav: NavItem[]
  active: string
  onNavigate: (id: string) => void
  children: ReactNode
}) {
  const activeItem = nav.find((n) => n.id === active)
  return (
    <div className="flex h-screen overflow-hidden bg-neutral-950">
      <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-neutral-800 py-3">
        <div className="mb-3 size-2.5 rounded-full bg-copper-400 shadow-[0_0_8px_2px_rgba(210,154,99,0.5)]" aria-hidden />
        {nav.map((item) => {
          const Icon = item.icon
          const isActive = item.id === active
          return (
            <button
              key={item.id}
              type="button"
              title={item.label}
              onClick={() => onNavigate(item.id)}
              className={`group relative flex size-10 items-center justify-center rounded-lg transition-colors ${
                isActive
                  ? 'bg-copper-500/15 text-copper-300'
                  : 'text-neutral-500 hover:bg-neutral-800/60 hover:text-neutral-300'
              }`}
            >
              {isActive && (
                <span className="absolute left-0 h-5 w-0.5 -translate-x-2 rounded-full bg-copper-400" aria-hidden />
              )}
              <Icon size={18} strokeWidth={1.8} />
            </button>
          )
        })}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-neutral-800 px-5 py-3">
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-sm font-bold tracking-[0.28em] text-neutral-100 uppercase">
              MyBrain <span className="text-copper-400">Agentic OS</span>
            </h1>
            <span className="rounded border border-neutral-700 px-1.5 py-0.5 font-mono text-[9px] tracking-widest text-neutral-500">
              {version}
            </span>
            {activeItem && (
              <span className="hidden font-mono text-[11px] tracking-[0.2em] text-neutral-500 uppercase sm:inline">
                / {activeItem.label}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">{status}</div>
        </header>
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
