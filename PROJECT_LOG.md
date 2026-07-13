# PROJECT_LOG.md — MyBrain Agentic OS Dashboard

## A note on sourcing

This log was requested as a per-phase summary "based on the git commit
history." As of this writing, `git log` shows exactly **one commit**:

```
a90f1dc  Fase 4: dashboard base — frontend, backend, endpoints validados
         josh0797 <josias.martin90@gmail.com>, 2026-07-10
```

There are no separate commits for Phases 0–3 — that work landed in this
single commit alongside Phase 4. The phase breakdown below is reconstructed
from README.md's "Estado de fases" checklist and cross-checked against the
actual files in `backend/src/` and `frontend/src/`, not from distinct
commits per phase. Where the README claims a phase is done, I verified the
corresponding code exists before including it here.

## Phase-by-phase

### Phase 0 — Environment audit
No dedicated code artifact; groundwork (confirming Node/npm/Python/Claude
CLI prerequisites per README.md) ahead of scaffolding.

### Phase 1 — Monorepo, frontend and backend base
- npm workspaces root (`package.json`, `package-lock.json`) wiring
  `backend/` and `frontend/` together under one `npm run dev`.
- Backend: Express app skeleton (`backend/src/app.ts`, `server.ts`),
  binds to `127.0.0.1` only — refuses to start on any other host.
- `GET /api/health` (`backend/src/routes/health.ts`) — service name,
  version, uptime, and whether the configured vault path exists on disk.
- Frontend: Vite + React skeleton (`frontend/src/main.tsx`, `App.tsx`).

### Phase 2 — Real vault reads
- `GET /api/vault-summary` (`routes/vault.ts` → `services/vault.ts`) —
  parses YAML frontmatter out of `1_Projects/`, `2_Areas/`, `0_Inbox/` to
  build dashboard counts. Pure filesystem read, no `claude` process spawned.
- `GET /api/last-log` (`routes/last-log.ts`) — tails
  `.claude/nightly.log` from the vault (bounded line count, size-capped).
- Frontend: `VaultPanel.tsx`, `NightlyLogPanel.tsx`.

### Phase 3 — RunManager, logs, and SSE
- `services/run-manager.ts` — tracks spawned child processes (run
  id, status, retained log lines), enforces one run per `mutexGroup` at a
  time (`RunConflictError`).
- `services/run-log.ts` — bounded, redacted log retention per run.
- Endpoints (`routes/runs.ts`): `GET /api/runs`, `GET /api/runs/:id`,
  `POST /api/runs/:id/cancel`, `GET /api/runs/:id/stream` (Server-Sent
  Events — replays retained log lines then streams live, resumable via
  `Last-Event-ID`).
- Only run kind exposed at this phase: `POST /api/run/self-test`, a fixed
  harmless diagnostic (`services/run-definitions.ts`) that spawns Node
  itself printing a few lines — proves the spawn/log/stream pipeline works
  without touching the vault.
- Frontend: `RunLogPanel.tsx`.

### Phase 4 — Claude actions (current HEAD)
- `runners/claude.ts` / `runners/claude-actions.ts` — a **fixed catalog**
  of `claude -p` invocations (`CLAUDE_ACTION_SPECS`). The frontend can only
  select a `kind` by name; command, prompt, `cwd`, `--allowedTools`, and
  timeout are all hardcoded server-side — there is no generic "run
  arbitrary prompt" endpoint.
- `GET /api/actions` (`routes/actions.ts`) — lists the catalog with a
  `configured`/`missing` flag per action (missing prompt files, missing
  env var *names* only — never values).
- Wired actions and their real state as of this commit:
  | kind | purpose | configured? |
  |---|---|---|
  | `inbox-classify` | classify `0_Inbox` notes into PARA folders | **no** — prompt file `.claude/prompts/inbox-classify.txt` doesn't exist yet in the vault |
  | `nightly-consolidation` | on-demand version of the 23:00 cron (orphan notes, MOCs, strategic flags) | yes — prompt is embedded verbatim, sourced from the actual crontab entry |
  | `weekly-digest` | UPD Urns digest from read-only Odoo pulls, on demand | yes, if `.claude/prompts/weekly-digest.txt`, the odoo-sync script, and `ODOO_URL`/`ODOO_USERNAME`/`ODOO_API_KEY` are all present |
  | `ghl-sync-colma` / `ghl-sync-upd-urns` | read/sync a GHL pipeline into the vault (never writes to GHL) | **no** — the `ghl-sync` skill, its prompt files, and `GHL_API_TOKEN`/`GHL_LOCATION_ID` don't exist/aren't set yet |
  | `auth-probe` | fixed one-line reply, confirms the `claude` CLI is authenticated and reachable from a spawned process | yes, always |
- `POST /api/run/ghl-sync` takes `{ business: "colma" | "upd-urns" }` and
  maps it through a fixed lookup table — the request body selects between
  two predefined definitions, never gets interpolated into a command.
- Frontend: `ActionsPanel.tsx`.

### Phase 5 — Odoo read-only integration — **not built**
README marks this unchecked, and the code confirms it: there is no
`routes/odoo.ts` and no `/api/odoo/*` endpoint in this backend. The PRD
(§5.2) specs `GET /api/odoo/inventory|top-clients|declining-clients|
overdue-invoices` as direct wrappers around `odoo_sync.py` (bypassing
`claude -p` for speed/cost, since these are pure reads) — none of that
exists yet.

The **only** current path from this dashboard to Odoo is indirect: the
`weekly-digest` Claude action's `--allowedTools` scope permits it to shell
out to `python3 .claude/skills/odoo-sync/odoo_sync.py`, but that happens
inside a full `claude -p` run, not a lightweight backend route.

### Phases 6–8 — Dashboard visual polish, document cards, tests/security/docs
README marks all three unchecked. No corresponding code found.

## Major components — purpose summary

**Dashboard (frontend, React + Vite)**
Read-only visualization + action-trigger UI for the `MyBrain` vault. Never
touches the filesystem or spawns processes itself — every panel either
reads from a backend JSON endpoint (`VaultPanel`, `NightlyLogPanel`) or
triggers one of the fixed backend actions and watches its log stream
(`ActionsPanel`, `RunLogPanel`).

**Backend endpoints (Node + Express, `127.0.0.1`-only)**
Two distinct patterns by design (per PRD §5.2), both present in code:
- *Passive reads* — `/api/health`, `/api/vault-summary`, `/api/last-log`:
  plain `fs` reads, no subprocess, no token cost.
- *Fixed action triggers* — `/api/run/*`, `/api/runs*`: spawn exactly one
  of a hardcoded set of `claude -p` (or diagnostic) commands per `kind`,
  track them via `RunManager`, and expose status/logs via polling or SSE.
  The request body can only select *which* predefined action runs, never
  its command, arguments, or working directory.

**Odoo integration**
Planned, not implemented as dashboard endpoints. Today, Odoo data only
reaches this system through the vault's own `odoo-sync` skill
(`.claude/skills/odoo-sync/odoo_sync.py`, read-only, in the `MyBrain`
repo) — either run manually or via the `weekly-digest` action's scoped
Bash access. Building direct `/api/odoo/*` routes is Phase 5, still open.
