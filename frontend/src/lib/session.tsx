import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { useApiGet } from './api'

export interface SessionInfo {
  email: string | null
  role: 'admin' | 'viewer'
  source: 'local' | 'access'
  canWrite: boolean
}

/**
 * Who the viewer is, per the backend. Locally you are always admin; through the
 * Cloudflare Tunnel your Access identity decides. The UI hides what you cannot
 * do — the backend enforces it regardless (roleGuard), this is just so viewers
 * aren't shown buttons that would 403.
 */
const SessionContext = createContext<SessionInfo>({
  email: null,
  role: 'admin',
  source: 'local',
  canWrite: true,
})

export function SessionProvider({ children }: { children: ReactNode }) {
  const state = useApiGet<SessionInfo>('/api/session', 300_000)
  // Until we know, assume read-only so no write UI flashes for a viewer.
  const value: SessionInfo =
    state.status === 'success'
      ? state.data
      : { email: null, role: 'viewer', source: 'access', canWrite: false }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionInfo {
  return useContext(SessionContext)
}
