import os from 'node:os'
import { config } from '../config/index.js'
import { CLAUDE_RUN_DEFINITIONS } from '../runners/claude-actions.js'
import type { RunDefinition } from './run-manager.js'

/**
 * Registry of everything the backend is able to run. The frontend can only
 * name a `kind` — command, args, cwd and timeout are fixed here and can never
 * be influenced by request data.
 */

// Fixed diagnostic script: prints a few lines on a timer, exercises stdout,
// stderr and a clean exit. Writes nothing, reads nothing, cwd is the OS temp
// dir — it cannot touch the vault.
const SELF_TEST_SCRIPT = `
let i = 0;
const max = 6;
const timer = setInterval(() => {
  i += 1;
  console.log('self-test line ' + i + '/' + max + ' — spawn pipeline OK');
  if (i === 2) console.error('self-test stderr probe line');
  if (i >= max) {
    clearInterval(timer);
    console.log('self-test finished cleanly');
  }
}, 400);
`.trim()

export const RUN_DEFINITIONS: Record<string, RunDefinition> = {
  'self-test': {
    kind: 'self-test',
    title: 'Pipeline self-test (fixed harmless command)',
    mutexGroup: 'diagnostics',
    timeoutMs: 30_000,
    build: () => ({
      // process.execPath = the exact Node binary running this backend; no PATH lookup.
      command: process.execPath,
      args: ['-e', SELF_TEST_SCRIPT],
      cwd: os.tmpdir(),
    }),
  },
  ...CLAUDE_RUN_DEFINITIONS,
}

export const RUN_MANAGER_LIMITS = {
  maxLogBytes: config.logs.maxRunLogBytes,
  maxRetained: config.runs.maxRetained,
  killGraceMs: config.runs.killGraceMs,
}
