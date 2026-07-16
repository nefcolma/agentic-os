import type { RequestHandler } from 'express'

/**
 * Local-only hardening. Binding to 127.0.0.1 keeps the network out, but a page
 * the user visits in their browser can still reach the loopback backend. These
 * guards close that gap.
 */

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Extracts the hostname from a Host header, handling IPv6 brackets and ports. */
function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']')
    return end === -1 ? hostHeader : hostHeader.slice(0, end + 1)
  }
  return hostHeader.split(':')[0] ?? ''
}

/**
 * Anti DNS-rebinding: an attacker domain can be made to resolve to 127.0.0.1,
 * which would make their page same-origin with this server. The Host header
 * still carries the attacker's domain, so reject anything not addressed to
 * localhost.
 */
export const hostGuard: RequestHandler = (req, res, next) => {
  const host = hostnameOf(req.headers.host ?? '')
  if (!LOCAL_HOSTNAMES.has(host)) {
    res.status(403).json({
      error: {
        code: 'FORBIDDEN_HOST',
        message: 'This backend only serves requests addressed to localhost.',
      },
    })
    return
  }
  next()
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
/** Sent by the dashboard's own fetch calls; a cross-site <form> cannot set it. */
export const REQUESTED_BY_HEADER = 'x-requested-by'
export const REQUESTED_BY_VALUE = 'agentic-os'

function isLocalOrigin(origin: string): boolean {
  try {
    return LOCAL_HOSTNAMES.has(new URL(origin).hostname)
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
  if (origin !== undefined && !isLocalOrigin(origin)) {
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
