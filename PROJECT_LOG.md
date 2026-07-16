# PROJECT_LOG.md — MyBrain Agentic OS Dashboard

Change history and feature-integration log for the local dashboard that
visualizes the `MyBrain` vault and triggers Claude Code / Odoo automations.
The authoritative spec is [PRD.md](PRD.md); this file records **what was
built, when, and why**, phase by phase.

## Sourcing note

This log is reconstructed from the git history, the README "Estado de fases"
checklist, and the actual code in `backend/src/` and `frontend/src/` —
verified against real endpoint output, not assumed from commit messages.

Git history at time of writing:

```
06ee1b4  Add PROJECT_LOG.md
a90f1dc  Fase 4: dashboard base — frontend, backend, endpoints validados
```

Phases 0–4 landed together under `a90f1dc`. **Phase 5 (Odoo) is implemented
in the working tree but not yet committed** at the time of this entry — see
its section below. The per-phase breakdown is finer-grained than the commits.

---

## Phase-by-phase history

### Phase 0 — Environment audit
Read-only groundwork before any code: confirmed Node v24 / npm 11 / Python
3.14 / git / `claude` 2.1.63 are present; confirmed the vault PARA structure
(`0_Inbox`, `1_Projects`, `2_Areas`, `.claude/`); located the real
`odoo-sync` skill, `odoo_sync.py`, and `weekly-digest.txt`; confirmed the
`ghl-sync` skill and inbox-classify prompt **do not exist yet**. Adopted the
vault's four operating files (`CLAUDE.md`, `USER.md`, `SOUL.md`,
`IDENTITY.md`) as binding rules: read-only vault, approval before any
write/move, strict UPD Urns / Colma / UPD Lean separation, Odoo read-only, no
external communications.

### Phase 1 — Monorepo, frontend, backend base
- npm workspaces root wiring `backend/` + `frontend/` under one `npm run dev`
  (concurrently). Scripts: `dev`, `build`, `typecheck`, `start`.
- Backend: Express + TypeScript, binds to **`127.0.0.1` only** — refuses to
  start on any non-loopback host (`config/index.ts` validates and throws).
- Centralized config (`config/index.ts`): host/port, `MYBRAIN_VAULT_PATH`,
  script paths, process timeouts, log-size caps — one source of truth.
- `GET /api/health` — service, version, uptime, vault-exists.
- Frontend: Vite + React 19 + Tailwind v4, command-center shell (near-black,
  monospace, status pills, copper accent).
- **Fix during phase:** the preview harness injects a generic `PORT`; the
  backend was renamed to read `BACKEND_PORT` so tooling can't hijack the bind.

### Phase 2 — Real vault reads
- `services/vault.ts` + `GET /api/vault-summary` — parses YAML frontmatter
  (`gray-matter`) from `1_Projects/`, `2_Areas/`, `0_Inbox/`. Pure `fs`
  read, no subprocess. Notes with broken/missing frontmatter are still
  counted and flagged, never crash the summary.
- `utils/tail.ts` + `GET /api/last-log` — byte-bounded tail of
  `.claude/nightly.log`; returns an honest `not_found` state when the log
  doesn't exist rather than fabricating a timestamp.
- `utils/params.ts` — bounded-integer query validation (reused later).
- Frontend: `VaultPanel`, `NightlyLogPanel`. Verified counts match the real
  vault exactly (4 projects / 3 areas / 1 inbox).

### Phase 3 — RunManager, logs, SSE
- `services/run-manager.ts` — process lifecycle
  (`queued→running→succeeded/failed/cancelled`), one run per `mutexGroup`
  (`RunConflictError`), timeout with SIGTERM→SIGKILL escalation, launch-error
  handling (no zombie runs).
- `services/run-log.ts` — per-run byte-bounded log; oldest lines evicted
  (`truncatedHead`), oversized single lines cut.
- `utils/redact.ts` — secret redaction applied **at ingestion**, before a
  line is stored or streamed: exact env-value matches (ODOO_*, GHL_*,
  ANTHROPIC_*) plus generic token patterns. Line-buffered so a secret can't
  slip through split across chunks.
- Endpoints: `GET /api/runs`, `GET /api/runs/:id`, `POST /api/runs/:id/cancel`,
  `GET /api/runs/:id/stream` (SSE — replays retained log then follows live,
  resumable via `Last-Event-ID`, single cleanup path on disconnect).
- Only run kind at this phase: `POST /api/run/self-test`, a fixed harmless
  Node diagnostic — proves the spawn/log/stream pipeline with **no** vault
  contact and **no** Claude. `spawn` with an args array, `shell:false`.
- Verified by a 7-case integration suite (redaction with fake secrets, exit
  codes, mutex lock + cancel, timeout, byte cap, listener cleanup).
- Frontend: `RunLogPanel` with live SSE streaming.

### Phase 4 — Claude actions
- `runners/claude.ts` + `runners/claude-actions.ts` — a **fixed catalog**
  (`CLAUDE_ACTION_SPECS`). The frontend can only name a `kind`; command,
  prompt source, `cwd`, `--allowedTools`, and timeout are all server-side.
  No generic "run any prompt" endpoint exists.
- Every `claude -p` invocation carries an explicit `--allowedTools` list
  (validated against CLI 2.1.63: `--allowedTools`, `--output-format
  stream-json`, `--verbose`) so a headless run can't hang on interactive
  approval. `cwd` is always the vault for vault actions.
- Prompt handling (never bundled to the frontend, never returned whole by the
  API): `weekly-digest` and `inbox-classify` are read **fresh from vault
  files** on every run; `nightly-consolidation` uses the **verbatim crontab
  prompt** (audited), with an optional override file that wins if present.
  Logs record only provenance (source path + length + tool scope), never
  prompt body or secrets.
- Child-env sanitization: the spawned `claude` gets the inherited env **minus**
  `ANTHROPIC_BASE_URL`/`*_API_KEY`/`*_AUTH_TOKEN` and `CLAUDECODE`/`CLAUDE_CODE_*`
  so auth is always the user's subscription login (PRD §6) and nested-session
  guards can't fire.
- `GET /api/actions` — catalog with `configured`/`missing` per action
  (missing file paths and env var **names** only, never values).
- Endpoints: `POST /api/run/inbox-classify`, `/nightly-consolidation`,
  `/weekly-digest`, `/ghl-sync` (`{business:"colma"|"upd-urns"}` via a fixed
  lookup), `/auth-probe`. Not-configured actions reject with `503
  NOT_CONFIGURED` and create no run.
- State as built: `nightly-consolidation` + `weekly-digest` + `auth-probe`
  configured; `inbox-classify` and both `ghl-sync` actions **not configured**
  (missing prompt/skill/env — shown honestly, never mocked).
- Frontend: `ActionsPanel` with a two-step confirm on vault-writing actions.
- **Finding (still open):** the non-destructive `auth-probe` returned `401
  Invalid authentication credentials`. The stored `claude` credential is
  expired/revoked even though `claude auth status` says logged-in. This is
  now corroborated by `.claude/nightly.log`, which contains only "Not logged
  in · Please run /login" — the nightly cron is failing for the same reason.
  **Action required from the user: run `claude auth login`.** No dashboard
  code can fix this; it's a machine-level credential.

### Phase 5 — Odoo read-only integration *(new — this entry)*
Direct, deterministic Odoo reads with no Claude in the loop (PRD §5.2: pure
`search_read`, so no reasoning, no token cost, no write risk).

- `runners/odoo.ts` — `OdooRunner`. Spawns `python3 odoo_sync.py <sub> …`
  with a fixed argv array, `shell:false`, `cwd` = vault, `ODOO_TIMEOUT_MS`
  timeout, and an 8 MB stdout guard. Separate from `RunManager` (those are
  long-running reasoning jobs; these are fast request/response reads).
- Strict per-parameter validation before anything becomes an argv entry:
  `days` 1–365, `limit` 1–500, `minOrders` 1–100, `businessOnly` bool,
  `product` ≤100 chars with newlines stripped. Bad input → `400 BAD_REQUEST`.
- Typed response envelopes with a computed, **honest** summary from real
  fields only (e.g. inventory out-of-stock/low-stock counts from actual
  quantities — no fabricated dollar valuation the query doesn't fetch), plus
  a `pulledAt` timestamp and the query echoed back.
- Structured error handling: Odoo/CLI failures never leak `stderr` (which can
  echo a connection string) — it's run through the redactor and generalized
  before reaching the client; full detail stays in the server log.
- Endpoints (all answer `200` with a discriminated `status` of
  `ok`/`not_configured`/`error` so the auto-loading panels render their five
  UI states cleanly; only bad params `400`):
  `GET /api/odoo/inventory`, `/top-clients`, `/declining-clients`,
  `/overdue-invoices`.
- Read-only enforced at three layers: `odoo_sync.py` uses only `search_read`;
  the backend never calls a write subcommand; and no endpoint accepts write
  input. Verified: running the pulls created **zero** files in the vault.
- Frontend: `OdooPanel` (4 cards, auto-load + 5-min read-only refresh) with a
  **Recharts** horizontal bar chart for top clients (copper bars), honest
  empty states ("No declining recurring accounts detected.", "No overdue
  invoices."), and per-card `not_configured`/`error` rendering.
- **Verified against the real Odoo instance (read-only):** inventory (walnut)
  99 lines / 43 out-of-stock; top clients 30d = 8 clients / $30,609; declining
  (90d, ≥5 orders, business-only) = 0 (empty state); overdue = 50 invoices /
  $12,918. Param validation returns 400 on `days=abc` and `days=9999`.

### Phase 5.5 — Knowledge viewer + Data Quality Center *(inserted feature)*
Requested mid-project: port two ideas from a reference dashboard
(`tylers-business-brain-v8.1.jsx`) — its Google-Drive "baked" data viewer and
its quality-control issue structure — **without** adopting the reference's
architecture where real business data is baked into the frontend bundle.

Decision (user-approved): **hybrid** data holding + **Drive and vault as two
separated sources**. Concretely:

- **Read-only Drive extraction.** The shared Drive folder "obsidianbus"
  (`1qjGOwd5VRkCfaR2MfESUGqmHKFGEYv2b`, owned by tylerscontact@gmail.com,
  shared with the user) was extracted read-only via the Drive connector — full
  content for the six `00_SYSTEM` files, structure + real summaries for
  `04_SKILLS` and `03_MEMORY/Companies`, folder structure for the rest. No
  writes to Drive. Result baked into `backend/data/knowledge-snapshot.json`.
- **Backend snapshot layer, not a frontend bundle.** Real data lives only in
  `backend/data/` (**gitignored**), served on localhost — never committed,
  never shipped in the client bundle. `services/knowledge.ts` +
  `routes/knowledge.ts`: `GET /api/knowledge/sources` (both sources, metadata
  only), `GET /api/knowledge/doc?source=&id=` (one doc, markdown cleaned +
  redacted; vault notes read fresh with a path-traversal guard),
  `POST /api/knowledge/export` (writes a portable "baked" bundle to a gitignored
  dir on demand — the "hybrid" export).
- **Two sources kept strictly separate** (per the vault separation rules): the
  Drive snapshot and the local MyBrain vault are shown side by side but never
  merged.
- **Data Quality Center** (`services/quality/*`, `GET /api/quality/issues`):
  deterministic detectors over **live** Odoo data — negative inventory,
  missing SKU/default_code, duplicate customers, near-zero-residual overdue
  invoices, incomplete partner records — plus a stale-snapshot check. Every
  issue carries the eleven review fields (type, severity, status, confidence,
  source, detected-date, evidence, business impact, affected metrics, proposed
  owner, recommendation). **Detection-only**: it never writes to Odoo; any
  correction is flagged as a write requiring explicit confirmation.
- **Frontend**: `KnowledgePanel` (source switcher, category cards, a Markdown
  document modal with "Open in Obsidian" for vault notes, export button) and
  `QualityPanel` (severity filters + per-issue cards exposing all eleven
  fields). A small dependency-free Markdown renderer (`lib/markdown.tsx`).
- **Verified against real data**: Drive snapshot serves 11 categories / 14
  mapped docs (6 with full content); the doc modal renders real `index.md`
  content cleanly; the vault modal produces `obsidian://open?vault=MyBrain&…`;
  the quality scan found 3 real issues from live Odoo (310 negative-inventory
  lines = critical; 1 missing-SKU; 77 duplicated partner labels). `git status`
  on the vault: unchanged — the extraction and features wrote nothing to it.

### Phase 6 — Command-center shell + Knowledge Map *(this entry)*
Requested: combine the reference dashboard's interface (top bar, left icon
nav, orbital "knowledge map" constellation) with the panels already built.

- **Shell** (`components/Shell.tsx`): a left icon-rail nav (lucide-react icons)
  + top bar (brand, version, active-view label, live system status with vault
  counts). `App.tsx` refactored from one long scroll into six navigable
  **views** — Command (System + Vault + Nightly log), Knowledge Map, Actions
  (Actions + Run Log), Odoo, Data Quality, Knowledge — each mounting the
  existing, unchanged panels.
- **Knowledge Map** (`modules/KnowledgeMap.tsx`): an SVG constellation driven
  by real data. `GET /api/knowledge/graph?source=drive|vault` builds
  nodes/links: structural links (core→hub→doc) are always real, and gold
  **cross-reference** links come from actual `[[wikilinks]]` parsed from
  document content — never invented (Drive shows 0 today since the linked docs
  are stubs; the vault shows 16 real cross-links). Two layouts: **Rings**
  (deterministic trig) and **Constellation** (a small seeded force relaxation,
  no d3 dependency), with a spin slider + auto-rotate, a file-names toggle,
  hover neighbor-highlighting, and click-to-open (reuses the shared `DocModal`,
  resolving each doc's real vault path for "Open in Obsidian").
- `DocModal` extracted from `KnowledgePanel` into `components/DocModal.tsx` so
  both the knowledge browser and the map open documents the same way; added
  Esc-to-close.
- **Verified in-browser**: all six views render; the Drive map shows 26
  nodes / 11 hubs, the vault map shows the 16 gold cross-links; both layouts
  work; clicking a map node opens the real note with the correct
  `obsidian://open?vault=MyBrain&file=…` URI; no console errors; typecheck +
  build clean; the vault is untouched.

### Phase 7 — Document cards: "Regenerate" with preview/diff/confirm *(this entry)*
The PRD's Pattern B ("a Regenerate button that triggers a `claude -p` call to
overwrite and refresh the note"), implemented under the vault's rule 9 — never
overwrite silently; preview, show a diff, require explicit confirmation.

**Two-phase design (and the one deliberate deviation from the PRD):**
- **Preview** (`POST /api/regenerate/preview`) — `claude -p` runs **read-only**
  (`--output-format text --allowedTools Read`, cwd = vault, sanitized env) and
  emits a proposed refresh on stdout. Nothing is written. A fixed prompt
  template instructs it to preserve frontmatter, invent nothing, and emit only
  the markdown. The only per-request input is the note id, resolved through the
  same validated vault-path guard used by the doc reader.
- **Confirm** — the modal renders a line-level diff (LCS, `lib/diff.ts`) with
  +added/−removed counts. Nothing happens without an explicit click.
- **Apply** (`POST /api/regenerate/apply`) — the backend writes **exactly the
  approved bytes** and first backs up the previous version to
  `backend/data/regenerate-backups/` (gitignored); the change then lands in the
  vault's own git for review/revert.

*Deviation, on purpose:* the PRD implies the overwrite itself should be a
`claude -p` call. Vault rule 9 requires approving the **exact** content, which a
second, non-deterministic Claude write could not guarantee. So generation goes
through Claude and the write applies the already-approved bytes. Documented in
README.

**Safeguards:** `.md`-only, inside-vault-only (path traversal + absolute paths
rejected), empty/too-short content refused, backup always taken, and this is
the *only* place the dashboard writes to the vault.

**Verification:**
- `regenerateApply` unit-tested against a **scratch vault** (never the real
  one): writes approved bytes exactly + backs up the previous version; rejects
  empty/short content leaving the note untouched; rejects `../` traversal,
  absolute paths, non-`.md`, and missing notes. 5/5 pass.
- `lineDiff` unit-tested: LCS keeps shared lines, reports +2/−1 correctly.
- Preview exercised end-to-end against the real CLI: returns `502 CLI_FAILED`
  with the actual 401 and an actionable hint, and the UI renders it with a Back
  button — **zero writes to the vault**.
- **Known blocker:** the full preview→diff→apply path cannot be demonstrated
  until the machine's `claude` credential is fixed (`claude auth login`); the
  same 401 first found in Phase 4 still stands.

### Per-user vault connection *(this entry)*
**Problem:** the vault path was frozen at startup from `MYBRAIN_VAULT_PATH`, so
the whole dashboard depended on one specific person's vault. Anyone else running
it had to edit `.env` and restart — and `runners/claude-actions.ts` baked the
vault into its specs at *module load*, so even an env change mid-process
wouldn't fully take.

**Fix — the active vault became runtime state:**
- `services/vault-settings.ts` — the single source of truth for the active
  vault: `getVaultPath()` / `vaultPaths()` (derived `.claude`, prompts, odoo
  script, nightly log), plus inspect / set / reset / detect. Precedence:
  user choice (`data/settings.json`, gitignored) > `MYBRAIN_VAULT_PATH` > default.
- `config` keeps only `defaultVaultPath` as a fallback; all vault-derived paths
  moved out. 39 usages across 8 files migrated to the runtime getters.
- `ClaudeActionSpec.promptSource` and `.cwd` became **lazy functions**, so the
  action catalog always follows the currently connected vault.
- Endpoints: `GET /api/vault/config`, `GET /api/vault/inspect?path=`,
  `GET /api/vault/detect`, `POST /api/vault/config`, `.../reset`.
- Frontend: a **Settings** view (gear nav) showing the connected vault + its
  health, a path input with *Check*, one-click *Use* for auto-detected vaults,
  and *Reset to default*. Connecting reloads the dashboard so every panel
  re-derives.

**Validation guardrails:** must exist, be a directory, and contain `.md` or
`.obsidian`; paths that are too broad (filesystem root, a top-level dir, or the
home dir) are refused — otherwise vault reads and the Regenerate write path
would have unrelated files in reach.

**Verified:** connecting a scratch vault changed `/api/vault-summary` (1 proj /
1 area), `/api/health`, and `/api/actions` (prompts now resolved inside the new
vault's `.claude/`) — all **without restarting the backend**, proving the lazy
refactor. Rejections confirmed for a missing path, the home dir, and a folder
with no notes. Reset restored the original vault (4/3/1).

### Phase 8 — Tests, security review, final docs *(this entry)*

**Test suite.** The per-phase checks that had lived in scratch files are now a
real suite in `backend/test/`, run with `npm test` (node:test, no new deps,
builds first): security guards, secret redaction + claude env sanitization,
`regenerateApply` against a scratch vault, and vault-path validation. **21/21
pass.**

**Security review** → [SECURITY.md](SECURITY.md). The threat model is written
around the one sentence the whole project rests on: *nothing but this machine's
loopback can reach the backend* — it has no auth precisely because of that.

Findings:
- **S1 · Critical (open, deploy decision)** — the `vercel.json` on `main`
  publishes the backend. With `ODOO_*` set in the host env, `/api/odoo/*` would
  serve real financials unauthenticated; and it cannot work anyway (no vault, no
  `claude`, no `python3`+`odoo_sync.py`, ephemeral FS, loopback guard). Auth
  would not fix the functional half. Recommendation: keep the backend local and
  front it with a tunnel + identity proxy (Cloudflare Access / Tailscale) if a
  URL with real data and real users is wanted.
- **S2 · High (fixed)** — **real CSRF hole, reproduced**: a cross-site `<form>`
  POST (no preflight) hit `POST /api/run/*` and started a vault-writing `claude`
  run — verified HTTP 202 against the live server. Fixed with `csrfGuard`
  (custom `X-Requested-By` header forces a preflight that fails cross-origin,
  plus `Origin`/`Sec-Fetch-Site` checks); same PoC now returns 403.
- **S3 · Medium (fixed)** — DNS rebinding; `hostGuard` rejects non-localhost
  `Host`.
- **S4 · Medium (fixed)** — over-broad vault paths refused.
- **S5 · Medium (mitigated by design)** — the Regenerate write path.
- **S6 · Low (diagnosed)** — the Vercel build crash is a **TypeScript 7 ↔
  `@vercel/backends`** incompatibility: TS7 (native port) no longer exposes
  `ts.sys` (verified `undefined`), and `@vercel/backends` calls
  `ts.readConfigFile(tsconfig, ts.sys.readFile)`. Not a defect in this codebase.
- **S7 · Info (open, user action)** — the machine's `claude` credential is
  invalid (401); blocks `/api/run/*` and Regenerate previews, and is why the
  nightly cron logs "Not logged in". Needs `claude auth login`.

**Docs.** README gained a Security section (with the "don't publish the backend"
guidance and the tunnel alternative) and `npm test`; SECURITY.md is new.

### Status
Phases 0–8 complete. Open items are not code: the deploy/auth decision (S1) and
the CLI credential (S7).

---

## New-feature integration notes

### Odoo metrics module (Phase 5)
The dashboard's first live business-data surface. Design deliberately keeps
the two backend patterns separate (PRD §5.2): **passive reads** (`/api/odoo/*`,
`/api/vault-summary`, `/api/last-log`) touch `fs`/`python3` directly with no
token cost; **reasoning actions** (`/api/run/*`) go through `claude -p`. A
"show me inventory" click never spins up a Claude session.

### Reference project
A reference dashboard (`tylers-business-brain-v8.1.jsx`) was reviewed for
structure only. It is a *baked, static* Google-Drive knowledge-base viewer; its
useful, non-proprietary takeaways were its Odoo snapshot taxonomy (inventory /
top-clients / declining-clients / overdue-invoices + pull-date) — which matched
the PRD's endpoint set — its quality-control issue schema (ported in Phase 5.5
over live data), and its dark, category-colored aesthetic. **No code or branding
was copied.** Its one architectural choice we deliberately did **not** adopt:
baking real business data into the frontend bundle. Where the reference embeds
data as constants in the JS, this dashboard keeps real data in a gitignored
backend snapshot served on localhost, or reads it live — never in the client
bundle or git.

### Vault activity observed (not produced by this project)
Between phases the vault changed on its own: `2_Areas/colma.md` and
`2_Areas/upd-urns.md` were edited (by the user), and `.claude/nightly.log` +
`Untitled.base` appeared. The dashboard treats the vault as read-only and did
not create or modify any of these. The dashboard now surfaces this real state:
the Vault panel's "last consolidation" reflects the log's mtime, and the
Nightly Log panel shows its actual content (the `/login` auth failure above).

---

## Component map — purpose summary

**Frontend (React + Vite + Tailwind, `127.0.0.1` only)**
Read-only visualization + action triggers. Panels: `VaultPanel`,
`NightlyLogPanel`, `ActionsPanel`, `RunLogPanel` (live SSE), `OdooPanel`
(Recharts). Never touches `fs` or spawns processes — every panel talks to a
backend JSON/SSE endpoint.

**Backend (Node + Express + TypeScript, `127.0.0.1` only)**
- *Passive reads*: `/api/health`, `/api/vault-summary`, `/api/last-log`,
  `/api/odoo/*` — `fs` or a direct `python3` read, no Claude, no token cost.
- *Fixed action triggers*: `/api/run/*`, `/api/runs*` — spawn exactly one of a
  hardcoded set of `claude -p`/diagnostic commands per `kind`, tracked by
  `RunManager`, exposed via polling or SSE. The request can only select
  *which* predefined action runs, never its command, args, or cwd.

**Security posture (carried through every phase)**
Loopback-only bind; secrets read from env, never sent to the frontend, never
logged (redacted at ingestion); `spawn` with arg arrays and `shell:false`
everywhere; Odoo strictly read-only; vault writes only ever happen through a
`claude -p` run governed by the vault's own `CLAUDE.md`, never by the
dashboard directly.
