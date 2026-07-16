// regenerateApply — writes only user-approved bytes, backs up, and refuses
// anything outside the vault. Runs against a SCRATCH vault; never the real one.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-vault-'))
process.env.MYBRAIN_VAULT_PATH = SCRATCH
process.env.KNOWLEDGE_EXPORT_DIR = path.join(SCRATCH, '_exports')
fs.mkdirSync(path.join(SCRATCH, '1_Projects'), { recursive: true })

const DIST = new URL('../dist/', import.meta.url).pathname
const { regenerateApply, RegenerateError } = await import(`${DIST}services/regenerate.js`)

const vid = (rel) => 'v-' + Buffer.from(rel, 'utf8').toString('base64url')
const NOTE_REL = '1_Projects/demo-note.md'
const NOTE_ABS = path.join(SCRATCH, NOTE_REL)
const ORIGINAL = '---\ntitle: Demo\ncreated: 2026-07-15\ntags: [test]\nstatus: active\n---\n\nOriginal body line.\n'
const APPROVED = '---\ntitle: Demo\ncreated: 2026-07-15\ntags: [test]\nstatus: active\n---\n\nRegenerated body, cleaner.\n'

before(() => fs.writeFileSync(NOTE_ABS, ORIGINAL, 'utf8'))
after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

test('writes exactly the approved bytes and backs up the previous version', async () => {
  await fsp.writeFile(NOTE_ABS, ORIGINAL, 'utf8')
  const res = await regenerateApply(vid(NOTE_REL), APPROVED)
  assert.equal(await fsp.readFile(NOTE_ABS, 'utf8'), APPROVED)
  assert.equal(res.bytesWritten, Buffer.byteLength(APPROVED))
  assert.equal(await fsp.readFile(res.backupFile, 'utf8'), ORIGINAL)
})

test('refuses empty/too-short content and leaves the note untouched', async () => {
  await fsp.writeFile(NOTE_ABS, ORIGINAL, 'utf8')
  for (const bad of ['', '   ', 'tiny']) {
    await assert.rejects(
      () => regenerateApply(vid(NOTE_REL), bad),
      (e) => e instanceof RegenerateError && e.code === 'BAD_CONTENT',
    )
  }
  assert.equal(await fsp.readFile(NOTE_ABS, 'utf8'), ORIGINAL)
})

test('rejects path traversal and absolute paths', async () => {
  const outside = path.join(os.tmpdir(), 'regen-outside.md')
  await fsp.writeFile(outside, 'DO NOT TOUCH\n', 'utf8')
  for (const bad of ['../regen-outside.md', '/etc/hosts']) {
    await assert.rejects(
      () => regenerateApply(vid(bad), APPROVED),
      (e) => e instanceof RegenerateError && e.code === 'NOT_FOUND',
    )
  }
  assert.equal(await fsp.readFile(outside, 'utf8'), 'DO NOT TOUCH\n')
})

test('rejects non-markdown targets and missing notes', async () => {
  await fsp.writeFile(path.join(SCRATCH, 'data.json'), '{}', 'utf8')
  for (const bad of ['data.json', '1_Projects/does-not-exist.md']) {
    await assert.rejects(
      () => regenerateApply(vid(bad), APPROVED),
      (e) => e instanceof RegenerateError && e.code === 'NOT_FOUND',
    )
  }
})
