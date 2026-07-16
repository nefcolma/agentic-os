import type { RequestHandler } from 'express'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { config } from '../config/index.js'
import { isRemoteHost } from './security.js'

/**
 * Identity + roles for remote (tunnel) traffic.
 *
 * Local requests (Host = localhost) are the machine's owner: full access — the
 * tool has always been theirs, and only they can reach loopback.
 *
 * Remote requests arrive on a declared TRUSTED_HOSTS hostname, i.e. through a
 * Cloudflare Tunnel. Those MUST carry a valid `Cf-Access-Jwt-Assertion`, which
 * is verified against Cloudflare's public keys — the plain
 * `Cf-Access-Authenticated-User-Email` header is NOT trusted on its own, since
 * anything able to reach the origin could forge it.
 *
 * Fail-closed: if Access is not configured, or the JWT is missing/invalid, a
 * remote request is refused. Misconfiguring the tunnel yields 403s, never an
 * unauthenticated door to the vault or Odoo.
 */

export type Role = 'admin' | 'viewer'

export interface Session {
  email: string | null
  role: Role
  source: 'local' | 'access'
}

declare module 'express-serve-static-core' {
  interface Request {
    session?: Session
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null
function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  jwks ??= createRemoteJWKSet(new URL(`https://${config.access.teamDomain}/cdn-cgi/access/certs`))
  return jwks
}

function deny(res: Parameters<RequestHandler>[1], code: string, message: string): void {
  res.status(403).json({ error: { code, message } })
}

/** Resolves req.session, verifying the Access JWT for remote traffic. */
export const accessGuard: RequestHandler = async (req, res, next) => {
  if (!isRemoteHost(req.headers.host ?? '')) {
    req.session = { email: null, role: 'admin', source: 'local' }
    next()
    return
  }

  // From here on the request came through the tunnel.
  if (config.access.teamDomain === '' || config.access.audience === '') {
    deny(
      res,
      'ACCESS_NOT_CONFIGURED',
      'Remote access requires Cloudflare Access (set ACCESS_TEAM_DOMAIN and ACCESS_AUD).',
    )
    return
  }

  const token = req.get('cf-access-jwt-assertion')
  if (!token) {
    deny(res, 'ACCESS_TOKEN_MISSING', 'Missing Cloudflare Access assertion.')
    return
  }

  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: `https://${config.access.teamDomain}`,
      audience: config.access.audience,
    })
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null
    if (!email) {
      deny(res, 'ACCESS_TOKEN_INVALID', 'Access assertion carries no email.')
      return
    }
    req.session = {
      email,
      role: config.access.adminEmails.includes(email) ? 'admin' : 'viewer',
      source: 'access',
    }
    next()
  } catch {
    deny(res, 'ACCESS_TOKEN_INVALID', 'Invalid Cloudflare Access assertion.')
  }
}

/**
 * Read-only enforcement: viewers may read everything but cannot change
 * anything — no runs, no Regenerate, no vault switching.
 */
export const roleGuard: RequestHandler = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    next()
    return
  }
  if (req.session?.role === 'admin') {
    next()
    return
  }
  deny(res, 'READ_ONLY', 'Your account has read-only access to this dashboard.')
}
