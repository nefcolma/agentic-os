/**
 * Secret redaction for process output. Applied to every log line BEFORE it is
 * stored in memory and BEFORE it is sent over SSE — redacted-at-ingestion, so
 * no unredacted text ever sits in a buffer or reaches the frontend.
 *
 * Two layers:
 *  1. Exact-value matches for known credential env vars (primary defense).
 *  2. Generic token-shape patterns (defense in depth).
 */

export type Redactor = (text: string) => string

/** Env vars whose *values* must never reach logs or the frontend. */
const SECRET_ENV_KEYS = [
  'ODOO_API_KEY',
  'ODOO_USERNAME',
  'ODOO_DB',
  'ODOO_URL',
  'GHL_API_TOKEN',
  'GHL_LOCATION_ID',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const

const GENERIC_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED:ANTHROPIC_KEY]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g, 'Bearer [REDACTED:TOKEN]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED:GITHUB_TOKEN]'],
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Builds a redactor from an environment map. Injectable for tests so real
 * credentials are never needed to verify the behavior.
 */
export function createRedactor(env: Record<string, string | undefined>): Redactor {
  const exact: Array<{ re: RegExp; replacement: string }> = []
  for (const key of SECRET_ENV_KEYS) {
    const value = env[key]
    // Values shorter than 4 chars would cause absurd over-redaction.
    if (typeof value === 'string' && value.length >= 4) {
      exact.push({ re: new RegExp(escapeRegExp(value), 'g'), replacement: `[REDACTED:${key}]` })
    }
  }

  return (text: string): string => {
    let out = text
    for (const { re, replacement } of exact) out = out.replace(re, replacement)
    for (const [re, replacement] of GENERIC_PATTERNS) out = out.replace(re, replacement)
    return out
  }
}

/** Default redactor bound to the real backend environment. */
export const redactSecrets: Redactor = createRedactor(process.env)
