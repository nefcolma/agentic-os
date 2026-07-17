import { spawn } from 'node:child_process'
import { config } from '../config/index.js'
import { redactSecrets } from '../utils/redact.js'
import { sanitizedClaudeEnv } from '../runners/claude.js'
import { getVaultPath } from './vault-settings.js'

/**
 * "Ask the Brain" — a Q&A chat grounded in the connected vault (and read-only
 * Odoo when relevant), answered by `claude -p`.
 *
 * This is the one place the frontend supplies a free-form prompt to Claude, so
 * it is deliberately constrained:
 *  - the question is passed as a spawn ARGV entry (no shell, no injection);
 *  - tools are READ-ONLY (Read + the read-only odoo script) — never Write/move;
 *  - cwd is the connected vault; child env is sanitized (owner's subscription);
 *  - concurrency is capped so it can't spawn unbounded Claude processes;
 *  - the endpoint is POST, so the read-only Access role can't reach it.
 */

const ASK_TIMEOUT_MS = 180_000
const MAX_QUESTION_CHARS = 2_000
const MAX_CONCURRENT = 2
let inFlight = 0

export type AskErrorCode = 'BAD_REQUEST' | 'BUSY' | 'CLI_FAILED'

export class AskError extends Error {
  constructor(
    message: string,
    public readonly code: AskErrorCode = 'CLI_FAILED',
  ) {
    super(message)
    this.name = 'AskError'
  }
}

/** Read-only tool scope: vault reads + the read-only Odoo pull script only. */
const ASK_TOOLS = 'Read,Bash(python3 .claude/skills/odoo-sync/odoo_sync.py:*)'

function askPrompt(question: string): string {
  return (
    'You are the assistant for this MyBrain vault, which is used as an operational command center. ' +
    "Answer the user's question using the vault's notes and, when it helps, the read-only Odoo script " +
    '(python3 .claude/skills/odoo-sync/odoo_sync.py). Be concise and bottom-line-first. ' +
    'Cite which notes or data you used. If you pull from Odoo, say it is live and give the pull context. ' +
    'Never invent numbers or facts. Never write, move, or delete anything — this is read-only.\n\n' +
    `Question: ${question}`
  )
}

export interface AskResult {
  answer: string
  generatedBy: string
}

export async function ask(rawQuestion: unknown): Promise<AskResult> {
  if (typeof rawQuestion !== 'string' || rawQuestion.trim() === '') {
    throw new AskError('A question is required.', 'BAD_REQUEST')
  }
  const question = rawQuestion.trim()
  if (question.length > MAX_QUESTION_CHARS) {
    throw new AskError(`Question is too long (max ${MAX_QUESTION_CHARS} chars).`, 'BAD_REQUEST')
  }
  if (inFlight >= MAX_CONCURRENT) {
    throw new AskError('Too many questions in flight — try again in a moment.', 'BUSY')
  }

  inFlight++
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          config.claudeBin,
          ['-p', askPrompt(question), '--output-format', 'text', '--allowedTools', ASK_TOOLS],
          { cwd: getVaultPath(), env: sanitizedClaudeEnv(), stdio: ['ignore', 'pipe', 'pipe'], shell: false },
        )
        const out: Buffer[] = []
        const err: Buffer[] = []
        child.stdout.on('data', (c: Buffer) => out.push(c))
        child.stderr.on('data', (c: Buffer) => err.push(c))
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new AskError('Question timed out.'))
        }, ASK_TIMEOUT_MS)
        timer.unref()
        child.on('error', (e) => {
          clearTimeout(timer)
          reject(new AskError(`Failed to launch claude: ${redactSecrets(e.message)}`))
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve({
            code,
            stdout: Buffer.concat(out).toString('utf8'),
            stderr: Buffer.concat(err).toString('utf8'),
          })
        })
      },
    )
    if (result.code !== 0) {
      const detail = redactSecrets((result.stderr || result.stdout).trim()) || `exit ${String(result.code)}`
      throw new AskError(`Claude CLI failed: ${detail}`)
    }
    const answer = redactSecrets(result.stdout).trim()
    if (answer === '') throw new AskError('Claude returned an empty answer.')
    return { answer, generatedBy: 'claude -p · read-only · vault + Odoo' }
  } finally {
    inFlight--
  }
}
