# PRD — MyBrain Agentic OS Dashboard

## 1. Overview

A local, single-user web dashboard that visualizes the state of the `MyBrain` Obsidian vault (business metrics, project/area status, recent activity) and lets the user trigger predefined Claude Code headless (`-p`) automations — inbox classification, nightly consolidation, GHL sync — via buttons, instead of typing prompts in the Claude Code chat.

This is a **local-only internal tool**, not a hosted product. It runs entirely on the user's machine, reads the vault's local filesystem directly, and shells out to the local `claude` CLI. No user data leaves the machine except the same API calls Claude Code itself already makes.

## 2. Goals

- Visualize vault state at a glance: open projects, active areas, recent inbox items, last consolidation run, GHL sync status, and live Odoo business metrics (inventory, top clients, declining accounts, overdue invoices).
- Let the user trigger the standing automations (inbox classification, nightly consolidation, GHL sync) with one click instead of retyping prompts.
- Show the raw output/log of each triggered run so the user can review before trusting it.
- Zero additional per-token cost beyond what the user's Claude subscription already covers (see Section 6).

## 3. Non-Goals

- Not a replacement for Claude Code itself — it does not implement its own reasoning; every action is a thin wrapper around a `claude -p` call using prompts already defined in the setup guide.
- Not multi-user, not authenticated, not exposed outside `localhost`.
- Does not write to GHL (read/sync only, per the `ghl-sync` skill's default behavior).
- Not a replacement for git review — actions that create/move files still land in the local git repo; the user reviews/commits as usual.

## 4. Architecture — 3 layers (not 2)

A browser cannot execute shell commands directly. The correct shape is:

```
┌─────────────────────┐      HTTP (localhost only)      ┌──────────────────────┐
│  Frontend (React)   │ ───────────────────────────────▶ │  Local backend        │
│  Dashboard UI,       │ ◀─────────────────────────────── │  (Node/Express)       │
│  buttons, metrics    │         JSON responses           │  Runs on 127.0.0.1     │
└─────────────────────┘                                   └───────────┬──────────┘
                                                                       │ spawns
                                                                       ▼
                                                          ┌──────────────────────┐
                                                          │  claude -p "..."      │
                                                          │  (child process)      │
                                                          └───────────┬──────────┘
                                                                       │ reads/writes
                                                                       ▼
                                                          ┌──────────────────────┐
                                                          │  ~/Documents/MyBrain  │
                                                          │  (local git repo)     │
                                                          └──────────────────────┘
```

**Why a backend is required:** the frontend cannot read the vault's filesystem or spawn processes on its own (browser sandboxing). The backend is the only layer allowed to touch `child_process`/`fs`. Frontend and backend can be two processes in the same repo (e.g. Vite dev server + Express server) run together locally — this is not a cloud deployment.

## 5. Components

### 5.1 Frontend (React + Vite)
- Dashboard home: cards for open Projects (count + list from `1_Projects/`), active Areas (`2_Areas/`), Inbox item count (`0_Inbox/`), last nightly consolidation timestamp (parsed from `.claude/nightly.log`).
- Action panel: buttons for "Classify Inbox," "Run Nightly Consolidation Now," "Sync GHL — Colma," "Sync GHL — UPD Urns," "Generate Weekly Digest Now," each calling a backend endpoint.
- Odoo metrics panel (read-only, auto-loads on dashboard open): "Inventory Check" (walnut/low-stock view), "Top Clients (30d)," "Declining Accounts," "Overdue Invoices" — each rendered as a card/chart pulling from the `/api/odoo/*` endpoints. These are data views, not action buttons, since the odoo-sync skill is read-only by design.
- Run log viewer: shows the streamed/most-recent output of the last triggered action (stdout from the backend's `claude -p` call).
- Read-only. All file mutations happen through `claude -p`, never directly from the frontend.
- Document Cards: Clicking a card (e.g., Morning Report) instantly opens a modal rendering the existing markdown note from the vault (Pattern A). The modal must include a "Regenerate" button that triggers a `claude -p` call to overwrite and refresh the summary on-demand (Pattern B), and an "Open in Obsidian" button using the `obsidian://open?file=...` URI scheme.

### 5.2 Backend (Node + Express, `localhost` only)
- Binds explicitly to `127.0.0.1` — never `0.0.0.0` — so it's unreachable from the network.
- Endpoints:
  - `GET /api/vault-summary` — reads the vault filesystem (frontmatter of files in `1_Projects/`, `2_Areas/`, `0_Inbox/`) and returns counts/summaries as JSON. Pure `fs` read, no `claude` call.
  - `POST /api/run/inbox-classify` — spawns `claude -p "<Section 8.1 prompt>" --allowedTools "Read,Write,Bash(git:*)" --output-format json`, streams/returns the result.
  - `POST /api/run/nightly-consolidation` — same pattern with the Section 8.3/12.2 prompt.
  - `POST /api/run/ghl-sync` — body `{ business: "colma" | "upd-urns" }`, spawns `claude -p` with a prompt invoking the `ghl-sync` skill for that business's pipeline.
  - `GET /api/odoo/inventory` — body/query `{ product?: string }`, spawns `python3 .claude/skills/odoo-sync/odoo_sync.py inventory --product <product>` directly (no `claude -p` needed — this is a pure read, faster and cheaper to call the script straight). Returns parsed JSON. **Read-only**, per the `odoo-sync` skill's hard boundary.
  - `GET /api/odoo/top-clients` — query `{ days?: number, businessOnly?: boolean }`, runs the `top-clients` subcommand. Returns revenue leaders.
  - `GET /api/odoo/declining-clients` — query `{ days?, minOrders?, businessOnly? }`, runs `declining-clients`. Returns at-risk recurring accounts.
  - `GET /api/odoo/overdue-invoices` — runs `overdue-invoices`. Returns genuinely past-due, unpaid invoices.
  - `POST /api/run/weekly-digest` — spawns `claude -p "$(cat .claude/prompts/weekly-digest.txt)"`, the same prompt the Monday cron runs, for on-demand generation.
  - `GET /api/last-log` — tails `.claude/nightly.log` and returns the last N lines.

  Note the two distinct backend patterns: **read-only data fetches** (`/api/odoo/*`) call the Python script directly and return JSON for the dashboard to chart — no Claude reasoning, no token cost, no write risk. **Automations that create/edit notes** (`/api/run/*`) go through `claude -p` because they involve judgment (classification, consolidation, digest writing). Keep these separate so a simple "show me inventory" button never spins up a full Claude session.
- Every `claude -p` invocation must include explicit `--allowedTools` (or an equivalent pre-approved permission mode) — **without this, the call hangs waiting for an interactive approval that will never come**, since there's no terminal attached.
- Working directory for every spawned process must be `~/Documents/MyBrain` (equivalent to `cd` before running).
- No GHL token, no Anthropic credentials, ever appear in a frontend response or in client-visible logs.

### 5.3 Data layer
- No database. The vault's own markdown files + frontmatter are the source of truth.
- The backend parses YAML frontmatter (title, created, tags, status) from files under `1_Projects/`, `2_Areas/`, `0_Inbox/` to build dashboard counts — a lightweight YAML frontmatter parser (e.g. `gray-matter` npm package) is sufficient; no need to invoke Claude for this read-only summary.

## 6. Cost model

Running `claude -p` from the backend, authenticated via the same subscription login the Desktop app already uses (not a separate `ANTHROPIC_API_KEY`), draws from the same Pro/Max plan usage as any interactive Claude Code session — it is not billed as a separate pay-per-token API key. Confirm current plan limits at support.claude.com before relying on this for heavy/frequent automation, since Anthropic can change billing mechanics.

## 7. Security requirements

- Backend listens on `127.0.0.1` only; no external network exposure, no auth layer needed since it's single-user/local-only.
- GHL credentials (`GHL_API_TOKEN`, `GHL_LOCATION_ID`) and Odoo credentials (`ODOO_URL`, `ODOO_DB`, `ODOO_USERNAME`, `ODOO_API_KEY`) are read from the backend process's environment variables only (from `~/.zshenv`, so the backend inherits them the same way cron does) — never hardcoded, never sent to the frontend, never logged in plaintext.
- All destructive/bulk actions (file moves, renames) still go through Claude Code's existing `CLAUDE.md` rule requiring a proposed plan — the dashboard does not bypass this; it only triggers the same prompts already governed by that rule.
- The dashboard itself never deletes files; it only triggers prompts that create, edit, or (with prior approval baked into `CLAUDE.md`) move files.

## 8. Tech stack

- Frontend: React + Vite, Tailwind for styling (per this environment's frontend-design conventions), no backend framework coupling.
- Backend: Node.js + Express, `child_process.spawn` (not `exec`, to avoid shell-injection risk with prompt text) to invoke `claude -p` and the Python scripts.
- Frontmatter parsing: `gray-matter` (npm).
- Charts for the Odoo metrics panel: `recharts` (npm) — lightweight, React-native, good for the top-clients bar chart and revenue trends.
- Run both with a single `npm run dev` script (concurrently runs Vite + Express) for local development.

## 8b. Visual direction

The reference aesthetic (dark command-center layout with labeled branches, status badges, monospace accents) is achievable entirely in the frontend with Tailwind — it is not a downloadable app or template. Concretely: a dark theme (`bg-neutral-950`/`bg-neutral-900` cards), a monospace font (e.g. `ui-monospace`/`JetBrains Mono`) for labels and metrics to get the "terminal/ops" feel, colored status pills (green = live/on-demand, amber = scheduled), and a grid of metric cards grouped by domain (Memory, Sales, Finance, etc.). Ask the generator model to match this description; don't look for an app to install. A "SYSTEM STATUS · LIVE" style header badge showing counts (skills, routines, integrations) is a nice touch and trivial to render from the `/api/vault-summary` response.

## 9. Open questions / assumptions to confirm before building

1. Should the dashboard show a live-streaming log (via `--output-format stream-json`) or just the final result once the command completes? Streaming is more complex (needs Server-Sent Events or WebSockets between backend and frontend) but gives better UX for long-running consolidation runs.
2. Should GHL sync buttons be scoped per-business (Colma vs. UPD Urns vs. UPD Lean) as separate buttons, or one button with a dropdown?
3. Where should this dashboard's own code live — inside `MyBrain` itself (e.g. `MyBrain/.dashboard/`) or as a fully separate repo that just points at the vault path via a config value? Recommendation: separate repo, since it's tooling, not vault content, and shouldn't be swept up in vault-focused git operations (commits, Routines, GitHub mirroring from the companion Claude Code Web guide).

## 10. Handoff instructions for the generator model

Give this entire PRD, plus the exact prompts already defined in the `Claude Code + Obsidian — Setup Guide` (Sections 8.1, 8.3) and the `ghl-sync` skill above, to the code-generation model in a single message. Do not paraphrase the prompts — pass them verbatim so the generated backend code embeds the exact same strings already validated in this vault.