// Vault connection validation — guards what the rest of the system may point at.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-settings-'))
process.env.MYBRAIN_VAULT_PATH = SCRATCH
const DIST = new URL('../dist/', import.meta.url).pathname
const { inspectVault } = await import(`${DIST}services/vault-settings.js`)

test('accepts a folder containing markdown notes', () => {
  fs.mkdirSync(path.join(SCRATCH, '1_Projects'), { recursive: true })
  fs.writeFileSync(path.join(SCRATCH, '1_Projects', 'a.md'), '# note\n')
  const s = inspectVault(SCRATCH)
  assert.equal(s.looksLikeVault, true)
  assert.equal(s.problem, undefined)
  assert.ok(s.markdownCount >= 1)
})

test('rejects a non-existent path', () => {
  assert.match(inspectVault('/no/such/folder').problem, /does not exist/i)
})

test('rejects the home directory as too broad', () => {
  assert.match(inspectVault(os.homedir()).problem, /too broad/i)
})

test('rejects the filesystem root as too broad', () => {
  assert.match(inspectVault('/').problem, /too broad/i)
})

test('rejects a folder with no notes', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'))
  fs.mkdirSync(path.join(empty, 'sub'), { recursive: true })
  assert.match(inspectVault(empty).problem, /no markdown/i)
  fs.rmSync(empty, { recursive: true, force: true })
})
