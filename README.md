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
| `MYBRAIN_VAULT_PATH` | `~/Documents/MyBrain` | Vault **por defecto** solamente. Cada usuario conecta el suyo desde la UI (ver abajo); esa elección manda. |
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
npm test           # 21 pruebas: guards de seguridad, redacción, regenerate, validación de vault
npm run typecheck  # TypeScript estricto en ambos workspaces
npm run build      # compila backend (tsc) y frontend (vite build)
```

## Seguridad — léelo antes de exponer nada

Este dashboard **no tiene autenticación, a propósito**: el PRD lo permite solo
porque el backend es inalcanzable salvo desde `127.0.0.1`. Toda la seguridad del
proyecto descansa en esa frase.

- **No despliegues el backend en un host público** (Vercel u otro). Sin auth
  expondría tus finanzas reales de Odoo, y además no funcionaría: en serverless
  no hay vault, ni CLI de `claude`, ni `python3 odoo_sync.py`.
- ¿Quieres una URL con datos reales y control de acceso? Deja el backend en tu
  máquina y ponle delante un túnel + proxy de identidad (Cloudflare Tunnel +
  Access, o Tailscale). Ahí defines el super-admin y agregas usuarios por email,
  sin mover datos ni escribir una capa de auth.
- Aun en local, el backend rechaza peticiones cross-site que cambien estado
  (`X-Requested-By` + chequeo de `Origin`/`Sec-Fetch-Site`) y peticiones cuyo
  `Host` no sea localhost (anti DNS-rebinding).

Detalle completo, hallazgos y riesgos residuales: **[SECURITY.md](SECURITY.md)**.

## Acceso remoto con Cloudflare Tunnel + Access (opcional)

La forma segura de darle una URL a tu equipo **con datos reales y en vivo**, sin
mover nada de tu máquina y sin escribir una capa de auth. El backend sigue atado
a `127.0.0.1`; el túnel es la entrada y Access es la identidad.

> ⚠️ **Nunca uses el "quick tunnel"** (`cloudflared tunnel --url ...`, URL
> `trycloudflare.com`): es público y sin autenticación.

### 1. Un solo origen
```bash
npm run build && npm start     # el backend sirve el frontend en :8790
```

### 2. Túnel
```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create agentic-os
cloudflared tunnel route dns agentic-os brain.tudominio.com
```

`~/.cloudflared/config.yml` — **sin `httpHostHeader`**: el backend necesita ver
el hostname real para distinguir el tráfico remoto del tuyo local.
```yaml
tunnel: <TU-UUID>
credentials-file: /Users/tu-usuario/.cloudflared/<TU-UUID>.json
ingress:
  - hostname: brain.tudominio.com
    service: http://127.0.0.1:8790
  - service: http_status:404
```

```bash
cloudflared tunnel run agentic-os     # prueba
sudo cloudflared service install      # que arranque solo
```

### 3. Access (la autenticación)
Zero Trust → **Access → Applications → Add an application → Self-hosted**:
- Domain: `brain.tudominio.com`
- Políticas: `Admin` → Allow → Emails → `neftali@colma.com`; `Equipo` → Allow →
  *Emails ending in* `@colma.com`
- Identity provider: *One-time PIN* (login por email) viene activo.

Desde ahí agregas y quitas usuarios **sin tocar código**.

### 4. Conecta el backend con Access (`.env`)
```bash
TRUSTED_HOSTS=brain.tudominio.com
TRUSTED_ORIGINS=https://brain.tudominio.com
ACCESS_TEAM_DOMAIN=tuequipo.cloudflareaccess.com
ACCESS_AUD=<Application Audience (AUD) Tag de la app en Access>
ADMIN_EMAILS=neftali@colma.com
```

### Cómo se comporta
| Origen | Identidad | Permisos |
|---|---|---|
| `localhost` (tu máquina) | dueño | **admin** — todo |
| Túnel, email en `ADMIN_EMAILS` | JWT de Access verificado | **admin** — todo |
| Túnel, cualquier otro email | JWT de Access verificado | **solo lectura** — ve todo en vivo (incluidos los logs SSE), no puede disparar nada |
| Túnel sin JWT válido | — | **403** |
| Cualquier otro Host | — | **403** |

**Fail-closed:** si Access queda mal configurado, el túnel devuelve 403 — nunca
una puerta abierta. El JWT se **verifica** contra las llaves públicas de
Cloudflare; la cabecera del email **no** se confía por sí sola.

## Estado de fases

- [x] Fase 0 — Auditoría del entorno
- [x] Fase 1 — Monorepo, frontend y backend base (`/api/health`)
- [x] Fase 2 — Lectura real del vault (`/api/vault-summary`, `/api/last-log`)
- [x] Fase 3 — RunManager, logs y SSE (`/api/runs`, `/api/runs/:id/stream`)
- [x] Fase 4 — Acciones Claude (`/api/run/*`, `/api/actions`; GHL e inbox-classify en "not configured")
- [x] Fase 5 — Integración Odoo read-only (`/api/odoo/*`, validación de params, datos reales)
- [x] Fase 5.5 — Visor de conocimiento (Drive snapshot + vault, `/api/knowledge/*`) y Data Quality Center (`/api/quality/issues`)
- [x] Fase 6 — Shell (barra superior + nav lateral) con vistas navegables y Knowledge Map orbital (`/api/knowledge/graph`)
- [x] Fase 7 — Document cards + "Regenerate" con preview/diff y confirmación explícita (`/api/regenerate/*`)
- [x] Vault conectable por usuario (Settings → runtime, sin reiniciar)
- [x] Fase 8 — Pruebas (`npm test`), hardening anti-CSRF/DNS-rebinding y revisión de seguridad ([SECURITY.md](SECURITY.md))
- [ ] Fase 6 — Dashboard visual completo
- [ ] Fase 7 — Document cards y modal Markdown
- [ ] Fase 8 — Pruebas, seguridad y documentación final

## Conecta tu propio vault (cada usuario el suyo)

El dashboard **no depende del vault de nadie en particular**. Al abrirlo, ve a
**Settings** (icono de engranaje) y conecta cualquier vault de Obsidian o
carpeta de notas de tu computadora:

- **Detección automática** — lista las carpetas de tu máquina que parecen vault
  (tienen `.obsidian` o `.claude`); un clic en *Use* y listo.
- **Ruta manual** — pega la ruta y usa *Check* para validarla antes de conectar.
- **Efecto inmediato** — todo (vault summary, Knowledge, acciones de Claude,
  Odoo, Regenerate) apunta al vault conectado **sin reiniciar** el backend.
- **Se guarda localmente** en `backend/data/settings.json` (gitignored), así que
  tu elección es tuya y no viaja al repo.

Precedencia: **tu elección en la UI** > `MYBRAIN_VAULT_PATH` > `~/Documents/MyBrain`.
*Reset to default* borra tu elección.

**Validaciones** (para que el resto del sistema no apunte a cualquier cosa): la
ruta debe existir, ser un directorio, contener notas `.md` o `.obsidian`, y se
rechazan rutas demasiado amplias (raíz del disco o tu carpeta de usuario) —
si no, la lectura del vault y la escritura de *Regenerate* tendrían al alcance
archivos que no son notas.

Endpoints: `GET /api/vault/config`, `GET /api/vault/inspect?path=`,
`GET /api/vault/detect`, `POST /api/vault/config`, `POST /api/vault/config/reset`.

## Knowledge snapshot (Drive) y Data Quality Center

**Visor de conocimiento** — dos fuentes estrictamente separadas:

- **Drive "obsidianbus"** (compartido, read-only): el backend **no tiene
  credenciales de Drive**; sirve un *snapshot* local generado por el agente
  (Claude) mediante extracción read-only. El snapshot vive en
  `backend/data/knowledge-snapshot.json` (**gitignored** — datos reales de
  negocio, nunca commiteados ni incrustados en el bundle del frontend).
  Para **re-hornear** (actualizar) el snapshot, pídele a Claude que vuelva a
  extraer el Drive; regenera el JSON con `node backend/data/build-snapshot.mjs`.
- **Vault MyBrain** (local): se lee fresco del disco en cada petición.

Endpoints: `GET /api/knowledge/sources`, `GET /api/knowledge/doc?source=&id=`,
`POST /api/knowledge/export` (escribe un bundle "baked" portable a
`backend/data/exports/`, también gitignored — para compartir/portar bajo demanda).

**Data Quality Center** — `GET /api/quality/issues` corre detectores
deterministas sobre tu Odoo **en vivo** (inventario negativo, SKUs faltantes,
clientes duplicados, facturas de residual casi-cero, registros de partner
incompletos) más una comprobación de frescura del snapshot. Cada issue trae
los 11 campos de revisión (tipo, severidad, estado, confianza, fuente, fecha,
evidencia, impacto, métricas afectadas, responsable, recomendación). **Solo
detecta y recomienda** — nunca escribe en Odoo; cualquier corrección quedaría
marcada como acción de escritura que requiere confirmación explícita.

## Regenerate (Pattern B) — cómo se protege tu vault

El botón **Regenerate** del modal de una nota del vault **nunca sobrescribe en
silencio**. El flujo tiene dos fases separadas:

1. **Preview** (`POST /api/regenerate/preview`) — corre `claude -p` en modo
   **solo-lectura** (`--allowedTools Read`), que lee la nota y emite una
   propuesta por stdout. **No escribe nada.**
2. **Confirmación** — la UI muestra un **diff línea a línea** (+añadidas /
   −eliminadas) de la nota actual vs. la propuesta. Sin tu clic explícito en
   *Confirm overwrite*, no pasa nada.
3. **Apply** (`POST /api/regenerate/apply`) — el backend escribe **exactamente
   los bytes que aprobaste** y guarda un **backup** de la versión previa en
   `backend/data/regenerate-backups/` (gitignored). El cambio queda en el git
   de tu vault para que lo revises/revirtas.

**Por qué el apply lo hace el backend y no un segundo `claude -p`:** el PRD
sugiere que Regenerate dispare un `claude -p` que sobrescriba, pero la regla 9
del vault exige aprobar el **contenido exacto** antes de escribir. Un segundo
`claude -p` podría generar algo distinto a lo que viste en el diff. Por eso la
*generación* va por Claude y la *escritura* aplica los bytes ya aprobados.

Salvaguardas: solo notas `.md` dentro del vault (anti path-traversal), se
rechaza contenido vacío o demasiado corto, y siempre hay backup.

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
