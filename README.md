# MyBrain Agentic OS Dashboard

Dashboard local, mono-usuario, que visualiza el estado del vault de Obsidian
`MyBrain` y dispara automatizaciones predefinidas de Claude Code headless
(`claude -p`) mediante botones. Ver [PRD.md](PRD.md) para la especificación completa.

**Estrictamente local**: el backend escucha solo en `127.0.0.1`, no hay
autenticación porque nada es accesible desde la red, y ningún dato sale de la
máquina más allá de las llamadas que Claude Code ya hace por sí mismo.

## Arquitectura (3 capas)

```
Frontend (React + Vite + Tailwind)  ── HTTP localhost ──▶  Backend (Node + Express, 127.0.0.1)
                                                                 │ child_process.spawn
                                                                 ▼
                                       claude -p / python3 odoo_sync.py  (cwd: vault MyBrain)
```

El navegador nunca toca el filesystem ni ejecuta comandos; solo el backend.

## Requisitos

- Node.js ≥ 20 (probado con v24)
- npm ≥ 10
- Python 3 (para las lecturas read-only de Odoo)
- Claude Code CLI (`claude`) autenticado con tu suscripción
- El vault en `~/Documents/MyBrain` (o la ruta que configures)

## Instalación

```bash
cd ~/Documents/agentic-os
npm install
```

## Configuración

```bash
cp .env.example .env
# edita .env si tu vault o puerto difieren de los valores por defecto
```

Variables principales (todas centralizadas en `backend/src/config/index.ts`):

| Variable | Default | Descripción |
|---|---|---|
| `BACKEND_PORT` | `8790` | Puerto del backend (no usa `PORT` para evitar colisiones con tooling del frontend) |
| `HOST` | `127.0.0.1` | Solo loopback; el servidor rechaza cualquier otro valor |
| `MYBRAIN_VAULT_PATH` | `~/Documents/MyBrain` | Ruta al vault |
| `CLAUDE_BIN` | `claude` | Binario de Claude Code |
| `CLAUDE_RUN_TIMEOUT_MS` | `900000` | Timeout de ejecuciones Claude |
| `ODOO_TIMEOUT_MS` | `60000` | Timeout del script de Odoo |
| `MAX_RUN_LOG_BYTES` | `1048576` | Tamaño máximo retenido por log de ejecución |

**Credenciales** (Odoo/GHL): viven en `~/.zshenv`, nunca en `.env` ni en el
repositorio. El backend solo reporta si están presentes o ausentes.

## Ejecución

```bash
npm run dev        # backend (tsx watch) + frontend (vite) concurrentes
```

- Frontend: http://127.0.0.1:5173
- Backend:  http://127.0.0.1:8790/api/health

Otros comandos:

```bash
npm run typecheck  # TypeScript estricto en ambos workspaces
npm run build      # compila backend (tsc) y frontend (vite build)
```

## Estado de fases

- [x] Fase 0 — Auditoría del entorno
- [x] Fase 1 — Monorepo, frontend y backend base (`/api/health`)
- [x] Fase 2 — Lectura real del vault (`/api/vault-summary`, `/api/last-log`)
- [x] Fase 3 — RunManager, logs y SSE (`/api/runs`, `/api/runs/:id/stream`)
- [x] Fase 4 — Acciones Claude (`/api/run/*`, `/api/actions`; GHL e inbox-classify en "not configured")
- [ ] Fase 5 — Integración Odoo read-only (`/api/odoo/*`)
- [ ] Fase 6 — Dashboard visual completo
- [ ] Fase 7 — Document cards y modal Markdown
- [ ] Fase 8 — Pruebas, seguridad y documentación final

## Troubleshooting

**El backend no arranca: "port already in use"**
Otro proceso ocupa el puerto. Cambia `PORT` en `.env` o libera el puerto:
`lsof -nP -iTCP:8790 -sTCP:LISTEN`.

**El backend se niega a arrancar por `HOST`**
Es intencional: solo se aceptan `127.0.0.1`, `localhost` o `::1`.
Este dashboard nunca debe exponerse a la red.

**La UI muestra "OFFLINE"**
El frontend no alcanza al backend. Verifica que `npm run dev` levantó ambos
procesos y que `curl http://127.0.0.1:8790/api/health` responde.

**"Vault: MISSING" en el panel de sistema**
`MYBRAIN_VAULT_PATH` no apunta a un directorio existente. Ajusta `.env`.

**Los paneles muestran "Not configured"**
Falta el artefacto correspondiente (p. ej. skill `ghl-sync`, credenciales GHL
o el prompt de inbox-classify). El dashboard nunca fabrica datos: muestra el
estado real y qué falta para activar cada módulo.
