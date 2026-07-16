// Remote identity + read-only role. Verifies the tunnel path fails CLOSED:
// no valid Cloudflare Access JWT ⇒ no access, and viewers cannot change state.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

process.env.TRUSTED_HOSTS = 'brain.example.com'
process.env.ACCESS_TEAM_DOMAIN = 'example.cloudflareaccess.com'
process.env.ACCESS_AUD = 'test-aud'
process.env.ADMIN_EMAILS = 'admin@example.com'

const DIST = new URL('../dist/', import.meta.url).pathname
const { createApp } = await import(`${DIST}app.js`)

let server
before(async () => {
  const app = createApp()
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
})
after(() => server?.close())

/** Raw request so we can forge Host — fetch() forbids setting it. */
function raw(method, pathname, hostHeader, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: pathname,
        method,
        headers: { Host: hostHeader, ...headers },
      },
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

test('local traffic is the machine owner: admin, may write', async () => {
  const res = await raw('GET', '/api/session', '127.0.0.1')
  assert.equal(res.status, 200)
  const s = JSON.parse(res.body)
  assert.equal(s.role, 'admin')
  assert.equal(s.source, 'local')
  assert.equal(s.canWrite, true)
})

test('tunnel traffic without an Access assertion is refused', async () => {
  const res = await raw('GET', '/api/session', 'brain.example.com')
  assert.equal(res.status, 403)
  assert.equal(JSON.parse(res.body).error.code, 'ACCESS_TOKEN_MISSING')
})

test('tunnel traffic with a forged email header is refused (header alone is not trusted)', async () => {
  const res = await raw('GET', '/api/session', 'brain.example.com', {
    'Cf-Access-Authenticated-User-Email': 'admin@example.com',
  })
  assert.equal(res.status, 403)
  assert.equal(JSON.parse(res.body).error.code, 'ACCESS_TOKEN_MISSING')
})

test('tunnel traffic with a bogus JWT is refused', async () => {
  const res = await raw('GET', '/api/session', 'brain.example.com', {
    'Cf-Access-Jwt-Assertion': 'not.a.jwt',
  })
  assert.equal(res.status, 403)
  assert.equal(JSON.parse(res.body).error.code, 'ACCESS_TOKEN_INVALID')
})

test('an undeclared host is still rejected outright', async () => {
  const res = await raw('GET', '/api/session', 'evil.example.com')
  assert.equal(res.status, 403)
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN_HOST')
})

test('roleGuard blocks writes for viewers', async () => {
  // Simulate the guard directly: a viewer session must not pass a POST.
  const { roleGuard } = await import(`${DIST}middleware/access.js`)
  const denied = []
  const res = {
    status(code) {
      denied.push(code)
      return this
    },
    json(body) {
      denied.push(body.error.code)
    },
  }
  let passed = false
  roleGuard({ method: 'POST', session: { role: 'viewer' } }, res, () => (passed = true))
  assert.equal(passed, false)
  assert.deepEqual(denied, [403, 'READ_ONLY'])

  // ...but reads are fine.
  let readPassed = false
  roleGuard({ method: 'GET', session: { role: 'viewer' } }, res, () => (readPassed = true))
  assert.equal(readPassed, true)
})

test('roleGuard allows writes for admins', async () => {
  const { roleGuard } = await import(`${DIST}middleware/access.js`)
  let passed = false
  roleGuard({ method: 'POST', session: { role: 'admin' } }, {}, () => (passed = true))
  assert.equal(passed, true)
})
