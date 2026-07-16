// Security guards: DNS-rebinding (Host) and CSRF (cross-site state changes).
// Runs the real Express app in-process on an ephemeral loopback port.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

const DIST = new URL('../dist/', import.meta.url).pathname
const { createApp } = await import(`${DIST}app.js`)

let server
let base

before(async () => {
  const app = createApp()
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => server?.close())

test('GET requests from the dashboard work normally', async () => {
  const res = await fetch(`${base}/api/health`)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).status, 'ok')
})

test('CSRF: cross-site form POST (no preflight) is rejected', async () => {
  // Exactly what a malicious page's <form> can send: simple content type, no
  // custom headers. Before the guard this started a vault-writing run.
  const res = await fetch(`${base}/api/run/self-test`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example.com', 'Content-Type': 'text/plain' },
  })
  assert.equal(res.status, 403)
  assert.equal((await res.json()).error.code, 'FORBIDDEN_ORIGIN')
})

test('CSRF: POST without the X-Requested-By header is rejected', async () => {
  const res = await fetch(`${base}/api/run/self-test`, { method: 'POST' })
  assert.equal(res.status, 403)
  assert.equal((await res.json()).error.code, 'MISSING_REQUESTED_BY')
})

test('CSRF: Sec-Fetch-Site cross-site is rejected even with the header', async () => {
  const res = await fetch(`${base}/api/run/self-test`, {
    method: 'POST',
    headers: { 'X-Requested-By': 'agentic-os', 'Sec-Fetch-Site': 'cross-site' },
  })
  assert.equal(res.status, 403)
})

test('CSRF: the dashboard\'s own POST is allowed', async () => {
  const res = await fetch(`${base}/api/run/self-test`, {
    method: 'POST',
    headers: { 'X-Requested-By': 'agentic-os', Origin: base },
  })
  assert.equal(res.status, 202)
  const { run } = await res.json()
  assert.equal(run.kind, 'self-test')
})

/** Raw request — fetch() forbids setting Host, which is exactly what we must forge here. */
function rawGet(pathname, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, path: pathname, method: 'GET', headers: { Host: hostHeader } },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

test('DNS rebinding: a non-localhost Host header is rejected', async () => {
  const res = await rawGet('/api/health', 'evil.example.com')
  assert.equal(res.status, 403)
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN_HOST')
})

test('DNS rebinding: a localhost Host header still works', async () => {
  const res = await rawGet('/api/health', '127.0.0.1')
  assert.equal(res.status, 200)
})

test('write endpoints are covered by the guard too', async () => {
  for (const path of ['/api/regenerate/apply', '/api/vault/config', '/api/knowledge/export']) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com', 'Content-Type': 'text/plain' },
    })
    assert.equal(res.status, 403, `${path} must reject cross-site POST`)
  }
})
