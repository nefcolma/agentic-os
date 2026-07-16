import { useEffect, useState } from 'react'

/** Discriminated request state used across the dashboard. */
export type ApiState<T> =
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; message: string; code?: string; httpStatus?: number }

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
    public readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

interface ApiErrorBody {
  error?: { code?: string; message?: string }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { Accept: 'application/json', ...init?.headers } })
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    let code: string | undefined
    try {
      const body = (await res.json()) as ApiErrorBody
      if (body.error?.message) detail = body.error.message
      code = body.error?.code
    } catch {
      // non-JSON error body; keep the status code
    }
    throw new ApiError(detail, res.status, code)
  }
  return (await res.json()) as T
}

export async function apiGet<T>(path: string): Promise<T> {
  return request<T>(path)
}

/**
 * Marks a request as coming from this dashboard. A cross-site <form> cannot set
 * a custom header, so requiring it makes the backend's state-changing endpoints
 * unreachable from other sites (the browser must preflight, which fails).
 */
const REQUESTED_BY = { 'X-Requested-By': 'agentic-os' } as const

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers:
      body === undefined ? { ...REQUESTED_BY } : { 'Content-Type': 'application/json', ...REQUESTED_BY },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** Fetches on mount and optionally re-fetches every `refreshMs`. */
export function useApiGet<T>(path: string, refreshMs?: number): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
      try {
        const data = await apiGet<T>(path)
        if (!cancelled) setState({ status: 'success', data })
      } catch (err) {
        if (!cancelled) {
          if (err instanceof ApiError) {
            setState({ status: 'error', message: err.message, code: err.code, httpStatus: err.httpStatus })
          } else {
            setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
          }
        }
      }
    }

    void load()
    const id = refreshMs !== undefined ? setInterval(() => void load(), refreshMs) : undefined
    return () => {
      cancelled = true
      if (id !== undefined) clearInterval(id)
    }
  }, [path, refreshMs])

  return state
}
