# Remote Access — Cloudflare Tunnel + Access

How to reach your locally running Agentic OS dashboard securely from anywhere,
without ever exposing the backend to the network.

## Architecture

```
Browser
  → Cloudflare Access        (identity check — who are you?)
    → Named Cloudflare Tunnel (outbound-only connection from your machine)
      → http://127.0.0.1:8790 (the Agentic OS backend, loopback only)
        → Agentic OS local
          → Vault / Claude CLI / Odoo
```

Traffic never reaches your machine directly. `cloudflared` opens an
**outbound** connection to Cloudflare; requests to your hostname ride that
connection back down to `127.0.0.1:8790`. Nothing listens on a public
interface, no ports are forwarded, and every remote request must first pass
Cloudflare Access.

## 1. Why the backend must remain local

The backend is not a stateless web service — it is a control plane over
resources that only exist on your machine:

- **The vault** is a local Obsidian folder. Routines run with `cwd` = the
  vault and read/write it directly on disk.
- **The Claude CLI** is spawned as a local child process and authenticates
  through your local subscription login (keychain) — not an API key that
  could be deployed elsewhere.
- **Odoo credentials** live in your local shell environment and are consumed
  by a local read-only Python script; they are never baked into any bundle.
- The backend **enforces loopback at startup**: it refuses to bind to
  anything other than `127.0.0.1` / `localhost` / `::1` by design. Remote
  reachability is achieved *only* through the tunnel, never by opening the
  bind address.

Moving the backend to a server would mean copying your vault, your Claude
session and your ERP credentials off your machine — exactly what the
local-first design exists to avoid.

## 2. Why Vercel cannot host it correctly

- Vercel runs **short-lived serverless functions**, not a persistent
  process. The backend needs long-lived state: the in-memory run manager,
  SSE streams for live logs, mutex groups, and spawned child processes
  (`claude`, `python3`) that can run for many minutes.
- Serverless functions **cannot spawn your local Claude CLI** or touch your
  local vault — those exist only on your machine.
- SSE log streaming and multi-minute run timeouts exceed serverless
  execution limits.
- Secrets (Odoo, Claude auth) would have to be uploaded to a third party.

Vercel remains fine for *static* frontends, but this backend serves its own
built frontend precisely so the tunnel needs only **one origin**. Deploying
the UI separately adds a second origin and CORS complexity for no benefit.

## 3. Requirements

- A domain **managed in Cloudflare** (its DNS zone lives in your Cloudflare
  account).
- `cloudflared` installed on the machine that runs Agentic OS
  (`brew install cloudflared` on macOS).
- Agentic OS **built and running locally**:

  ```bash
  npm run build
  npm start        # backend on http://127.0.0.1:8790, serving the built frontend
  ```

## 4. Create a named tunnel

```bash
# One-time login: opens the browser, authorizes cloudflared for your zone.
cloudflared tunnel login

# Create the tunnel. This writes a credentials JSON to ~/.cloudflared/.
cloudflared tunnel create agentic-os

# Route a hostname on your domain to the tunnel.
cloudflared tunnel route dns agentic-os os.yourdomain.com

# Run it (uses the config file below).
cloudflared tunnel run agentic-os
```

Note the tunnel UUID printed by `create` — it names the credentials file and
appears in `config.yml`.

## 5. Example `~/.cloudflared/config.yml`

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /Users/<you>/.cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: os.yourdomain.com
    service: http://127.0.0.1:8790
    # IMPORTANT: do NOT set originRequest.httpHostHeader here — see §7.
  - service: http_status:404
```

## 6. Do NOT use a Quick Tunnel

`cloudflared tunnel --url http://127.0.0.1:8790` (a *Quick Tunnel*) is
**explicitly unsuitable**:

- It generates a **random, ephemeral** `trycloudflare.com` URL on every run.
- It **cannot be protected by Cloudflare Access** — anyone who learns the
  URL reaches your dashboard with no identity check.
- The backend's security model requires a **stable, declared hostname**
  (`TRUSTED_HOSTS` / `TRUSTED_ORIGINS`); a URL that changes on every start
  can't be declared, so it would either be rejected or force you to weaken
  the configuration.

Always use a **named tunnel** on your own domain, behind Access.

## 7. Do NOT set `httpHostHeader`

Some guides suggest `originRequest.httpHostHeader: localhost` to make the
origin "accept" tunnel traffic. **Do not do this here.** The backend's
security middleware distinguishes local from remote traffic **by the real
`Host` header**:

- `Host: localhost` / `127.0.0.1` → treated as **local** traffic.
- `Host: os.yourdomain.com` (a declared trusted host) → treated as
  **remote**, and therefore **required to present a valid Cloudflare Access
  JWT** (fail-closed).

Rewriting the Host to `localhost` would make remote tunnel traffic look
local and **bypass the Access JWT requirement entirely**. The backend needs
to see the real hostname; instead of rewriting it, declare it:

```bash
# in .env (or your shell env) on the machine running the backend
TRUSTED_HOSTS=os.yourdomain.com
TRUSTED_ORIGINS=https://os.yourdomain.com
ACCESS_TEAM_DOMAIN=yourteam.cloudflareaccess.com
ACCESS_AUD=<Access application audience tag>
ADMIN_EMAILS=you@yourdomain.com
```

Everyone authenticated through Access can read; only `ADMIN_EMAILS` can
trigger actions or change anything.

## 8. Create the Self-hosted application in Cloudflare Access

In the Cloudflare dashboard (Zero Trust):

1. **Access → Applications → Add an application → Self-hosted.**
2. **Application domain:** `os.yourdomain.com` (the tunnel hostname).
3. **Session duration:** pick something reasonable (e.g. 24h).
4. **Policy:** `Allow` with an include rule such as *Emails* →
   `you@yourdomain.com` (and any other authorized users). Everything else is
   denied by default.
5. Save, then open the application's **Overview** and copy the
   **Application Audience (AUD) tag** → set it as `ACCESS_AUD` in the
   backend environment, together with `ACCESS_TEAM_DOMAIN`
   (`yourteam.cloudflareaccess.com`).
6. Restart the backend so the Access configuration is picked up.

After that, visiting `https://os.yourdomain.com` prompts a Cloudflare login;
only allowed identities ever reach the dashboard, and the backend
independently verifies the Access JWT on every remote request.
