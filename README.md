# OpenFrontIO Ephemeral Launcher

Spins up an exact copy of the OpenFrontIO game server at a specific git commit SHA on demand.

```
openfrontio/OpenFrontIO publishes a tag
        │
        ▼
GitHub Actions (your repo, free)
        │  clones OpenFrontIO @ tag SHA
        │  docker build + push → registry.fly.io
        │  (once per release, ~3-5 min)
        ▼
Image cached in Fly registry

User requests match replay
        │
        ▼
Cloudflare Worker
        │  resolves SHA from match API
        │  checks Fly registry for pre-built image
        │  if SHA matches latest release → redirect to production
        │  if no image → return "unavailable"
        │  otherwise: create game Machine from cached image
        ▼
Game live in ~20 seconds
```

---

## Prerequisites

- [flyctl](https://fly.io/docs/hands-on/install-flyctl/) installed & authenticated (`fly auth login`)
- [wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed & authenticated (`wrangler login`)
- A Fly.io account (credit card required)
- A Cloudflare account (free)

---

## Setup

### 1. Create Fly apps

```sh
fly apps create openfront-builder
fly apps create openfront-games
```

`openfront-builder` is only used as a registry namespace — no machines needed. `openfront-games` is where game machines are created dynamically.

### 2. Set GitHub Actions secrets and variables

In your repo → Settings → Secrets and variables → Actions:

**Secrets:**
- `FLY_API_TOKEN` — `fly tokens create deploy`

**Variables** (non-sensitive):
- `FLY_REGISTRY_APP` — `openfront-builder`

### 3. Create the Cloudflare KV namespace

```sh
cd worker
wrangler kv namespace create SESSIONS
# paste the resulting id into wrangler.toml under [[kv_namespaces]]
```

### 4. Set Cloudflare Worker secrets

```sh
wrangler secret put FLY_API_TOKEN   # same token as step 2
wrangler secret put FLY_GAMES_APP   # "openfront-games"
```

### 5. Deploy the Cloudflare Worker

```sh
cd worker
wrangler deploy
```

### 6. Trigger the first pre-build

Run the **Pre-build OpenFrontIO release image** workflow manually in GitHub Actions (Actions → select workflow → Run workflow). This builds and pushes the current latest release image so the first replay request is instant.

---

## File structure

```
.
├── .github/
│   └── workflows/
│       └── prebuild-release.yml   Polls OpenFrontIO releases daily,
│                                  pre-builds + pushes image on new tags
├── fly.games.toml                 Notes on the games app (machines created dynamically)
└── worker/
    ├── wrangler.toml              Cloudflare Worker config + KV binding
    └── src/
        └── index.js               Worker: UI, match API, registry check, session state
```

---

## How image caching works

Images are stored in Fly's registry under:
`registry.fly.io/openfront-builder/openfront:<sha>`

GitHub Actions polls OpenFrontIO releases daily. On a new tag it resolves the SHA, checks whether the image already exists in the registry, and builds + pushes if not. Matches replayed on released versions find their image already cached.

If a match's SHA has no pre-built image (e.g. an in-progress development commit), the Worker returns `{ status: "unavailable" }`. Only released versions can be replayed.

---

## Cost breakdown

| Resource | Cost |
|---|---|
| Cloudflare Worker + KV | Free |
| GitHub Actions pre-builds | Free (public repo) |
| Game machine (shared-cpu-1x, 512MB, auto_destroy) | ~$0.004/session |
| Fly registry storage | ~$0.02/GB/month |

Monthly total at low volume: roughly **$0.50/month**.
