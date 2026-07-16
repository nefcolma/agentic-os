// Secret redaction — applied before any log line is stored or streamed.
// Uses FAKE secrets only.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const DIST = new URL('../dist/', import.meta.url).pathname
const { createRedactor } = await import(`${DIST}utils/redact.js`)
const { sanitizedClaudeEnv } = await import(`${DIST}runners/claude.js`)

const FAKE = 'FAKE-ODOO-KEY-abc123-DO-NOT-PRINT'
const redact = createRedactor({ ODOO_API_KEY: FAKE, GHL_API_TOKEN: 'ghl-FAKE-999' })

test('redacts exact env secret values', () => {
  const out = redact(`connecting with key=${FAKE} now`)
  assert.ok(!out.includes(FAKE))
  assert.match(out, /\[REDACTED:ODOO_API_KEY\]/)
})

test('redacts generic token shapes', () => {
  assert.match(redact('sk-ant-abcdefgh12345678'), /\[REDACTED:ANTHROPIC_KEY\]/)
  assert.match(redact('Authorization: Bearer abcdef123456789'), /\[REDACTED:TOKEN\]/)
  assert.match(redact('token ghp_abcdefghij0123456789abcdefghij'), /\[REDACTED:GITHUB_TOKEN\]/)
})

test('leaves ordinary text alone', () => {
  assert.equal(redact('walnut urn inventory is negative'), 'walnut urn inventory is negative')
})

test('claude child env drops auth/session overrides but keeps the rest', () => {
  const env = sanitizedClaudeEnv({
    PATH: '/usr/bin',
    HOME: '/Users/x',
    ODOO_API_KEY: 'keep-me',
    ANTHROPIC_BASE_URL: 'x',
    ANTHROPIC_API_KEY: 'x',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'x',
  })
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'ODOO_API_KEY', 'PATH'])
})
