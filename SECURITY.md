# Security review — MyBrain Agentic OS Dashboard

Scope: the local dashboard in this repo (backend + frontend). Reviewed at the
close of Phase 8. This is a **local, single-user tool**; the review is written
against that design, and the biggest finding below is what happens when that
assumption is broken.

## Threat model

The backend is powerful by construction: it reads a personal vault, spawns
`claude` and `python3`, holds Odoo/GHL credentials in its environment, and (since
Phase 7) can overwrite vault notes. It has **no authentication**, and that is
deliberate — the PRD (§7) grants that only because it is unreachable except from
`127.0.0.1`.

So the security of this whole project rests on one sentence:

> **Nothing but this machine's loopback interface can reach the backend.**

Every finding below is about protecting that sentence, or about what breaks when
it stops being true.

## Findings

### S1 — Publishing the backend removes all protection · **Critical** · open (deploy decision)
A `vercel.json` was added on `main` that deploys the Express backend as a public
service with `/api/*` rewrites. If that deploy ever succeeds **with `ODOO_*` set
in the host's env**, `GET /api/odoo/*` serves real UPD Urns financials —
inventory, top clients by revenue, overdue invoices with customer names and
amounts — to anyone with the URL, unauthenticated. `POST /api/vault/config`,
`/api/regenerate/apply` and `/api/run/*` are equally open.

It also cannot work: there is no vault, no `claude` CLI, and no
`python3 odoo_sync.py` (that script lives *inside* the vault) on a serverless
host; the filesystem is ephemeral; and `config` refuses to start off-loopback.

**Recommendation:** do not deploy the backend. If a URL with real data and real
identity is wanted, keep the backend local and put a tunnel + identity proxy in
front (Cloudflare Tunnel + Access, or Tailscale) — that provides the
super-admin/add-users model without moving data or writing an auth layer.
Adding application auth does **not** address the functional half of this finding.

*Note:* the deploy currently fails for an unrelated reason (S6), so nothing is
exposed today.

### S2 — CSRF on state-changing endpoints · **High** · **fixed**
A page on any site the user visited could fire a simple cross-site `<form>` POST
at the loopback backend — no preflight, no consent — and hit endpoints that take
no body, e.g. `POST /api/run/nightly-consolidation`, which starts a `claude -p`
run that **writes to the vault**. Reproduced against the running dev server
(HTTP 202, run started).

**Fix:** `middleware/security.ts` `csrfGuard` — non-GET requests must carry
`X-Requested-By: agentic-os` (a custom header forces a CORS preflight, which
fails since the server sends no CORS headers) and are rejected on a cross-site
`Origin` or `Sec-Fetch-Site`. Verified: the same PoC now returns `403`.

### S3 — DNS rebinding · **Medium** · **fixed**
An attacker domain can resolve to `127.0.0.1`, making their page same-origin with
the backend and defeating Origin checks.

**Fix:** `hostGuard` rejects any request whose `Host` header is not
localhost/`127.0.0.1`/`::1`. Covered by tests (using a raw `node:http` request,
since `fetch` forbids forging `Host`).

### S4 — Vault path could point anywhere · **Medium** · **fixed**
When the vault became user-connectable, an over-broad path (`/`, a top-level dir,
or the home dir) would have put unrelated files in reach of vault reads and the
Regenerate write path.

**Fix:** `inspectVault` requires an existing directory containing `.md` or
`.obsidian`, and refuses roots/top-level/home. Covered by tests.

### S5 — Vault overwrite (Regenerate) · **Medium** · mitigated by design
`POST /api/regenerate/apply` is the only place the dashboard writes to the vault.

**Controls:** two-phase (read-only `claude -p` preview → line diff → explicit
confirm); writes only the user-approved bytes; `.md` inside the vault only (path
traversal and absolute paths rejected); empty/short content refused; a backup of
the previous version is written to a gitignored dir; the change lands in the
vault's own git for review/revert. Covered by tests against a scratch vault.

### S6 — Vercel build crash · **Low** (build-only) · diagnosed
`TypeError: Cannot read properties of undefined (reading 'readFile')` in
`@vercel/backends`' `doTypeCheck`. Root cause: this repo uses **TypeScript 7**
(the native port), which no longer exposes `ts.sys` (verified: `ts.sys` is
`undefined`), while `@vercel/backends` calls
`ts.readConfigFile(tsconfig, ts.sys.readFile)`. Not a defect in this codebase.
Resolving it means either removing the backend service from `vercel.json` (also
the fix for S1) or pinning TypeScript 5.x — only relevant if a deploy is
actually wanted.

### S7 — Claude CLI credential invalid · **Info** · open (user action)
The machine's stored `claude` credential returns `401 Invalid authentication
credentials` even though `claude auth status` reports logged-in. This blocks all
`/api/run/*` actions and Regenerate previews, and is why `.claude/nightly.log`
contains only "Not logged in · Please run /login" — the user's nightly cron is
failing for the same reason. **Action: run `claude auth login`.** No code change
can fix a machine-level credential.

## Remote access (Cloudflare Tunnel + Access)

The supported way to reach this dashboard from outside the machine. The backend
still binds `127.0.0.1`; a named tunnel is the only ingress and Cloudflare
Access is the identity layer. Design notes:

- **Local vs remote is decided by the Host header.** `localhost` ⇒ the machine's
  owner ⇒ admin. A hostname listed in `TRUSTED_HOSTS` ⇒ remote ⇒ must present
  identity. This is why `cloudflared` must **not** rewrite the Host
  (`httpHostHeader`): that would make tunnel traffic indistinguishable from the
  owner's and silently grant admin.
- **Declaring a trusted host grants nothing.** It only marks traffic as remote,
  which *raises* the bar.
- **The JWT is verified**, not trusted. `Cf-Access-Jwt-Assertion` is checked
  against Cloudflare's public keys (issuer + audience) via `jose`. The plain
  `Cf-Access-Authenticated-User-Email` header is deliberately ignored — anything
  that could reach the origin could forge it. Covered by a test.
- **Fail-closed.** Remote traffic with Access unconfigured, or a missing/invalid
  assertion, gets 403 — a misconfigured tunnel is a closed door, never an open
  one.
- **Roles.** `ADMIN_EMAILS` may write; every other authenticated identity is
  read-only (`roleGuard` rejects all non-GET). Viewers still see live data,
  including streaming run logs. The UI hides write controls, but the backend is
  the enforcement point.

Residual: the tunnel is only up while the machine is. That is inherent — the
vault and the `claude` CLI live there.

## Controls in place

- **Network:** binds `127.0.0.1` only; the server refuses to start on any
  non-loopback `HOST`. Plus `hostGuard` + `csrfGuard` (S2/S3).
- **Secrets:** read from the process environment only; never sent to the
  frontend, never written to logs. Run output is redacted **at ingestion**
  (before storage and before SSE) using exact env-value matches plus generic
  token shapes, line-buffered so a secret cannot slip through split across
  chunks. Errors from Odoo/Claude are redacted before surfacing.
- **Process execution:** always `spawn` with an argv array and `shell: false` —
  no shell, no string concatenation, no injection surface. The frontend can only
  name a fixed `kind`; command, args, prompt source and cwd live server-side.
  There is no generic "run anything" endpoint. Child env for `claude` is
  sanitized (auth/session overrides stripped) so it uses the user's own
  subscription login.
- **Odoo:** read-only by construction (`search_read` only in `odoo_sync.py`); the
  backend never calls a write subcommand and no endpoint accepts write input.
  Every query parameter is validated and bounded before becoming an argv entry.
- **Real data:** the Drive snapshot, exports, regenerate backups and
  `settings.json` live in `backend/data/` — **gitignored**, served only on
  loopback, never baked into the frontend bundle or committed.
- **Vault:** treated as read-only everywhere except the S5 path.

## Residual risks

- Any local process/user on this machine can reach the backend; there is no
  per-process authorization. Acceptable for a single-user local tool.
- The `X-Requested-By` guard defends against browser-driven CSRF, not against a
  malicious local program (which could set any header). Same acceptance.
- `backend/data/` holds real business data unencrypted on disk, with the user's
  filesystem permissions as the only control.

## Running the checks

```bash
npm test          # 21 tests: security guards, redaction, regenerate, vault validation
npm run typecheck
npm run build
```
