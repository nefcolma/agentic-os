import type { RequestHandler } from 'express'
import { config } from '../config/index.js'

/**
 * Local-only hardening. Binding to 127.0.0.1 keeps the network out, but a page
 * the user visits in their browser can still reach the loopback backend. These
 * guards close that gap.
 *
 * When a Cloudflare Tunnel is used, its hostname/origin must be declared via
 * TRUSTED_HOSTS / TRUSTED_ORIGINS. Traffic arriving on a trusted host is
 * treated as REMOTE and is separately required to carry a valid Access JWT
 * (see middleware/access.ts) — declaring a host here never grants access by
 * itself.
 */

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Extracts the hostname from a Host header, handling IPv6 brackets and ports. */
export function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']')
    return end === -1 ? hostHeader : hostHeader.slice(0, end + 1)
  }
  return hostHeader.split(':')[0] ?? ''
}

export function isLocalHostname(host: string): boolean {
  return LOCAL_HOSTNAMES.has(host)
}

/** True when the request arrived on a declared tunnel hostname, not loopback. */
export function isRemoteHost(hostHeader: string): boolean {
  const host = hostnameOf(hostHeader)
  return !isLocalHostname(host) && config.security.trustedHosts.includes(host)
}

/**
 * Anti DNS-rebinding: an attacker domain can be made to resolve to 127.0.0.1,
 * which would make their page same-origin with this server. The Host header
 * still carries the attacker's domain, so reject anything not addressed to
 * localhost or an explicitly trusted tunnel hostname.
 */
export const hostGuard: RequestHandler = (req, res, next) => {
  const host = hostnameOf(req.headers.host ?? '')
  if (isLocalHostname(host) || config.security.trustedHosts.includes(host)) {
    next()
    return
  }
  res.status(403).json({
    error: {
      code: 'FORBIDDEN_HOST',
      message: 'This backend only serves localhost or an explicitly trusted tunnel hostname.',
    },
  })
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
/** Sent by the dashboard's own fetch calls; a cross-site <form> cannot set it. */
export const REQUESTED_BY_HEADER = 'x-requested-by'
export const REQUESTED_BY_VALUE = 'agentic-os'

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    if (isLocalHostname(url.hostname)) return true
    return config.security.trustedOrigins.includes(origin) || config.security.trustedHosts.includes(url.hostname)
  } catch {
    return false
  }
}

/**
 * Anti-CSRF for state-changing requests. Without this, a page on any site the
 * user visits could fire a simple cross-site form POST at the loopback backend
 * and trigger a run that writes to the vault — no preflight, no consent.
 *
 * Requiring a custom header forces a CORS preflight, which fails because this
 * server sends no CORS headers. The Origin/Sec-Fetch-Site checks are defense in
 * depth for clients that send them.
 */
export const csrfGuard: RequestHandler = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    next()
    return
  }

  const origin = req.get('origin')
  if (origin !== undefined && !isAllowedOrigin(origin)) {
    res.status(403).json({
      error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-site requests are not allowed.' },
    })
    return
  }

  const site = req.get('sec-fetch-site')
  if (site !== undefined && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
    res.status(403).json({
      error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-site requests are not allowed.' },
    })
    return
  }

  if (req.get(REQUESTED_BY_HEADER) !== REQUESTED_BY_VALUE) {
    res.status(403).json({
      error: {
        code: 'MISSING_REQUESTED_BY',
        message: `State-changing requests require the ${REQUESTED_BY_HEADER}: ${REQUESTED_BY_VALUE} header.`,
      },
    })
    return
  }

  next()
}
