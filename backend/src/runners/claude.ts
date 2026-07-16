import fs from 'node:fs'
import { config } from '../config/index.js'
import type { RunDefinition } from '../services/run-manager.js'

/**
 * ClaudeRunner — turns a fixed action spec into a RunDefinition that spawns
 * the Claude Code CLI headless (`claude -p …`).
 *
 * Invariants:
 *  - Command, args, cwd, allowed tools and prompt source are fixed per spec;
 *    nothing is ever taken from an HTTP request.
 *  - Every invocation carries an explicit --allowedTools list (validated
 *    against the installed CLI, v2.1.63) so no interactive approval can hang
 *    a headless run.
 *  - cwd is always the MyBrain vault for vault actions.
 *  - Prompt text is never logged, never returned by the API and never
 *    shipped to the frontend; logs carry only the prompt's source + length.
 */

/**
 * Env vars that must NOT reach the spawned `claude` CLI:
 *  - ANTHROPIC_BASE_URL / *_API_KEY / *_AUTH_TOKEN redirect or override auth —
 *    the PRD (§6) mandates the user's subscription login (keychain), not an
 *    API key, so any inherited override would break auth or change billing.
 *  - CLAUDECODE / CLAUDE_CODE_* / CLAUDE_AGENT_SDK* mark a parent Claude Code
 *    session; inheriting them makes the CLI refuse to launch (nested-session
 *    guard) or reuse session-internal endpoints.
 * When the backend runs from a normal terminal none of these exist and this
 * is a no-op.
 */
const CLAUDE_CHILD_ENV_BLOCKLIST: RegExp[] = [
  /^ANTHROPIC_BASE_URL$/,
  /^ANTHROPIC_API_KEY$/,
  /^ANTHROPIC_AUTH_TOKEN$/,
  /^ANTHROPIC_CUSTOM_HEADERS$/,
  /^CLAUDECODE$/,
  /^CLAUDE_CODE_/,
  /^CLAUDE_AGENT_SDK/,
  /^CLAUDE_EFFORT$/,
]

/** Complete child environment for claude runs: inherited env minus auth/session overrides. */
export function sanitizedClaudeEnv(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (CLAUDE_CHILD_ENV_BLOCKLIST.some((re) => re.test(key))) continue
    env[key] = value
  }
  return env
}

export class NotConfiguredError extends Error {
  constructor(
    public readonly kind: string,
    public readonly missing: string[],
  ) {
    super(`Action "${kind}" is not configured. Missing: ${missing.join('; ')}`)
    this.name = 'NotConfiguredError'
  }
}

export type PromptSource =
  | {
      /** Prompt lives in a file (inside the vault's .claude/prompts). Read fresh on every run. */
      type: 'file'
      path: string
    }
  | {
      /**
       * Verbatim prompt from a verified external source (e.g. the user's
       * crontab, audited 2026-07-10). An optional override file wins when it
       * exists, so the user can externalize the prompt later without a code
       * change.
       */
      type: 'verified-inline'
      text: string
      provenance: string
      overrideFilePath?: string
    }

export interface ClaudeActionSpec {
  kind: string
  title: string
  description: string
  /** Mutex group — all vault-writing actions share 'vault-write'. */
  mutexGroup: string
  /**
   * Lazy on purpose: the active vault can change at runtime (the user connects
   * their own), so prompt paths and cwd must be resolved per run, never frozen
   * at module load.
   */
  promptSource: () => PromptSource
  /** Comma-separated tool list passed verbatim to --allowedTools. */
  allowedTools: string
  cwd: () => string
  timeoutMs: number
  /** Names of missing requirements (files, skills, env var NAMES — never values). */
  checkMissing: () => string[]
}

/** Exact argv for `claude` — exported for argument-generation tests. */
export function buildClaudeArgs(prompt: string, allowedTools: string): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--allowedTools',
    allowedTools,
  ]
}

export interface ResolvedPrompt {
  prompt: string
  /** Human-readable provenance for logs — path or provenance label, never content. */
  sourceNote: string
}

export function resolvePrompt(spec: ClaudeActionSpec): ResolvedPrompt {
  const source = spec.promptSource()
  if (source.type === 'file') {
    let text: string
    try {
      text = fs.readFileSync(source.path, 'utf8')
    } catch {
      throw new NotConfiguredError(spec.kind, [`prompt file ${source.path}`])
    }
    if (text.trim() === '') {
      throw new NotConfiguredError(spec.kind, [`prompt file ${source.path} is empty`])
    }
    return { prompt: text, sourceNote: `prompt: ${source.path} (${text.length} chars)` }
  }

  if (source.overrideFilePath && fs.existsSync(source.overrideFilePath)) {
    const text = fs.readFileSync(source.overrideFilePath, 'utf8')
    if (text.trim() !== '') {
      return {
        prompt: text,
        sourceNote: `prompt: override file ${source.overrideFilePath} (${text.length} chars)`,
      }
    }
  }
  return {
    prompt: source.text,
    sourceNote: `prompt: ${source.provenance} (${source.text.length} chars)`,
  }
}

/** Builds the RunManager definition for a Claude action spec. */
export function makeClaudeRunDefinition(spec: ClaudeActionSpec): RunDefinition {
  return {
    kind: spec.kind,
    title: spec.title,
    mutexGroup: spec.mutexGroup,
    timeoutMs: spec.timeoutMs,
    preflight: () => {
      const missing = spec.checkMissing()
      if (missing.length > 0) throw new NotConfiguredError(spec.kind, missing)
    },
    build: () => {
      // Fresh prompt read on every run — same behavior as the cron's $(cat …).
      // cwd resolves now, so a run always targets the currently connected vault.
      const { prompt, sourceNote } = resolvePrompt(spec)
      const cwd = spec.cwd()
      return {
        command: config.claudeBin,
        args: buildClaudeArgs(prompt, spec.allowedTools),
        cwd,
        env: sanitizedClaudeEnv(),
        note: `${sourceNote} · allowedTools=[${spec.allowedTools}] · cwd=${cwd}`,
      }
    },
  }
}
