# OpenFrontIO Ephemeral Launcher — Project Brief

## What this is

A tool that, given a match ID from the OpenFrontIO game, spins up an ephemeral copy of the game server running the exact git commit that match was played on, then redirects the user to it.

---

## Repository context

- **This repo** is yours — it contains the launcher infrastructure only
- **OpenFrontIO** (`openfrontio/OpenFrontIO`) is a public third-party repo you do not own. You clone it at build time (GitHub Actions); you never commit to it
- OpenFrontIO already has its own production `Dockerfile` (multi-stage, nginx + supervisord + Node.js cluster). You use it as-is — do not write a custom one

---

## Architecture

Two components + GitHub Actions:

### 1. Cloudflare Worker (`worker/`)
- Serves the UI (single HTML page, inline in the Worker script)
- Calls the match API to resolve a match ID → commit SHA
- **Match API:** `GET https://api.openfront.io/public/game/{gameID}?turns=false` — commit SHA is `response.gitCommit`
- **Production shortcut:** if the SHA matches the latest OpenFrontIO release tag, skips ephemeral env and redirects to `https://openfront.io/w{simpleHash(gameID)%20}/game/{gameID}`. Latest release SHA is cached in KV for 15 minutes.
- **Registry check:** calls Fly's Docker v2 manifest API to verify a pre-built image exists for the SHA. If not, returns `{ status: "unavailable" }`.
- Creates a Fly Machine directly via the Fly Machines API
- Stores session state in Cloudflare KV (TTL 3 hours)
- Polls machine state on `GET /api/status/:matchId` — transitions `launching` → `ready` when machine reaches `started`
- **Free** (Cloudflare Workers + KV free tier)

### 2. Fly Games App (`openfront-games`)
- Just a Fly app shell — no deployment needed
- Game machines are created and destroyed dynamically via the Fly Machines API
- Each machine runs OpenFrontIO's own Docker image: nginx on port 80, supervisord managing the Node.js cluster (master on 3000, workers on 3001-3003)
- Machine config: `shared-cpu-1x`, 512MB RAM, `auto_destroy: true`, `autostop: true`, `autostart: true`
- **Costs ~$0.004 per 30-min session**

### 3. GitHub Actions (`.github/workflows/prebuild-release.yml`)
- Polls `openfrontio/OpenFrontIO` releases daily via the GitHub API
- When a new release tag is detected, resolves it to a commit SHA, checks if the image already exists in the Fly registry, and builds + pushes if not
- Uses `actions/cache` for Docker layer caching between runs
- Can also be triggered manually via `workflow_dispatch` with a specific tag
- **Free** (public repo)

---

## Data flow

```
User enters match ID
        │
        ▼
Worker: GET match API → commit SHA
        │
        ├─ SHA == latest release SHA?
        │       YES → return { status: "production", url: openfront.io/w.../game/... }
        │
        ├─ Image in Fly registry?
        │       NO  → return { status: "unavailable" }
        │
        YES
        │
        ▼
Worker: create Fly Machine in openfront-games app
        store session { status: "launching", machineId }
        return { status: "launching" }
        │
        ▼
Client polls GET /api/status/:matchId
        Worker polls Fly machine state
        machine state = "started" → update session { status: "ready", url }
        return { status: "ready", url: /game/:matchId }
        │
        ▼
UI redirects user to /game/:matchId (Worker proxy → fly-replay → game machine)
```

---

## Session statuses

| Status | Meaning |
|---|---|
| `launching` | Fly Machine is being created and starting |
| `ready` | Machine is live, `url` is populated |
| `production` | SHA is latest release — redirect to production instead |
| `unavailable` | No pre-built image for this SHA |
| `error` | Pipeline failed, `error` field has message |
| `stopped` | Machine was destroyed |

---

## Environment variables / secrets

### Cloudflare Worker vars (`wrangler.toml [vars]`)
| Name | Value |
|---|---|
| `GHCR_OWNER` | GitHub username/org (e.g. `deshack`) |

### Cloudflare Worker secrets (`wrangler secret put`)
| Name | Description |
|---|---|
| `FLY_API_TOKEN` | Fly.io API token |
| `FLY_GAMES_APP` | Fly app name for game machines (`openfront-games`) |

### Cloudflare Worker KV binding
| Binding | Purpose |
|---|---|
| `SESSIONS` | Session state + latest release SHA cache |

### GitHub Actions secrets
| Name | Description |
|---|---|
| `FLY_API_TOKEN` | Fly.io API token |

GitHub Actions uses `GITHUB_TOKEN` (automatic) to push to ghcr.io — no variables or extra secrets needed.

---

## Key implementation details

- **Image ref pattern:** `ghcr.io/<GHCR_OWNER>/openfront:<sha>`
- **Registry check** uses ghcr.io's Docker v2 API with an anonymous pull token (two-step: `GET https://ghcr.io/token?...` → `GET https://ghcr.io/v2/<owner>/openfront/manifests/<sha>`). Works for public packages without credentials.
- **OpenFrontIO's nginx** listens on port 80 inside the container — game machines use `internal_port: 80`
- **Production SHA cache key** in KV: `__latest_release_sha__`, TTL 15 minutes; fails open (if GitHub unreachable, check is skipped)
- **Build args** passed to `docker build` in GitHub Actions: `GIT_COMMIT=<sha>`, `GAME_ENV=prod`
- **Game proxy** (`/game/:matchId/*`): sets `fly-replay: instance=<machineId>` header and uses HTMLRewriter to inject `<base href="/game/{matchId}/">` for relative asset paths
- **KV TTL minimum** is 60 seconds (Cloudflare enforces this)

---

## File structure

```
.
├── CLAUDE-instructions.md             This file
├── README.md                          Full setup instructions
├── .github/
│   └── workflows/
│       └── prebuild-release.yml       Pre-build images on new OpenFrontIO tags
├── fly.games.toml                     Notes on games app (no deploy needed)
└── worker/
    ├── wrangler.toml                  KV binding + vars + secret list
    └── src/
        └── index.js                   UI + launch + status polling + game proxy
```

---

## Known gaps

- No machine cleanup for the `openfront-games` app beyond the `DELETE /api/session/:matchId` endpoint — consider a periodic cleanup job for orphaned machines
