# OpenFrontIO Ephemeral Launcher

Spins up an exact copy of the OpenFrontIO game server at a specific git commit SHA on demand.

```
── Common path (released version) ──────────────────────────────────────────────

openfrontio/OpenFrontIO publishes a tag
        │
        ▼
GitHub Actions (your repo, free)
        │  clones OpenFrontIO @ tag SHA
        │  docker build + push → registry.fly.io
        │  (once per release, ~3-5 min)
        ▼
Image cached in Fly registry

User requests match → SHA is a released version → image already exists
        │
        ▼
Cloudflare Worker (free)
        │  calls Fly Machines API directly
        │  creates game Machine from cached image
        ▼
Game live in ~20 seconds

── Fallback path (unreleased / between-release SHA) ────────────────────────────

User requests match → SHA not in registry
        │
        ▼
Cloudflare Worker
        │  starts stopped builder Machine (~5s)
        │  waits for builder HTTP to be ready
        │  POST /build
        ▼
Fly Builder Machine (stopped when idle — $0 when not building)
        │  clones OpenFrontIO @ SHA
        │  docker build + push
        │  creates game Machine
        │  callbacks Worker with URL
        │  stops itself
        ▼
Game live in ~5-8 minutes
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

### 2. Generate a shared secret

```sh
openssl rand -hex 32
# copy this — use it as CALLBACK_SECRET everywhere below
```

### 3. Deploy the builder to Fly

```sh
fly deploy --config fly.builder.toml
fly scale count 1 --app openfront-builder
```

The scale command is required once — Fly defaults to 2 machines for HA, but the builder must be a singleton.

### 4. Get the builder machine ID (needed by the Worker to start/stop it)

```sh
fly machines list --app openfront-builder
# copy the machine ID from the output
```

### 5. Set Fly secrets on the builder

```sh
fly secrets set \
  FLY_API_TOKEN=$(fly tokens create deploy) \
  CALLBACK_SECRET=<your-secret-from-step-2> \
  --app openfront-builder
```

### 6. Stop the builder machine (it should idle as stopped)

```sh
fly machines stop <machine-id> --app openfront-builder
```

### 7. Set GitHub Actions secrets and variables

In your repo → Settings → Secrets and variables → Actions:

**Secrets:**
- `FLY_API_TOKEN` — same token as above

**Variables** (non-sensitive):
- `FLY_REGISTRY_APP` — `openfront-builder`

### 8. Create the Cloudflare KV namespace

```sh
cd worker
wrangler kv namespace create SESSIONS
# paste the resulting id into wrangler.toml
```

### 9. Set Cloudflare Worker secrets

```sh
wrangler secret put FLY_API_TOKEN              # same token as step 5
wrangler secret put FLY_GAMES_APP              # "openfront-games"
wrangler secret put FLY_BUILDER_APP            # "openfront-builder"
wrangler secret put FLY_BUILDER_MACHINE_ID     # machine ID from step 4
wrangler secret put CALLBACK_SECRET            # same secret as step 2
```

### 10. Deploy the Cloudflare Worker

```sh
cd worker
wrangler deploy
```

---

## File structure

```
.
├── .github/
│   └── workflows/
│       └── prebuild-release.yml   Polls OpenFrontIO releases every 15min,
│                                  pre-builds + pushes image on new tags
├── fly.builder.toml               Fly config for the builder machine
├── fly.games.toml                 Notes on the games app (machines created dynamically)
├── fly-builder/
│   ├── Dockerfile                 Node + Docker-in-Docker
│   ├── entrypoint.sh              Starts dockerd then Node
│   ├── package.json
│   └── src/
│       └── index.js               Express: build pipeline, self-stops after each job
└── worker/
    ├── wrangler.toml              Cloudflare Worker config + KV binding
    └── src/
        └── index.js               Worker: UI, match API, wake builder, session state
```

---

## How image caching works

Images are stored in Fly's registry under:
`registry.fly.io/openfront-builder/openfront:<sha>`

**Pre-built (common path):** GitHub Actions polls OpenFrontIO releases every 15 minutes.
On a new tag it resolves the SHA, checks whether the image exists, and builds + pushes
if not. Matches replayed on released versions find their image already cached.

**On-demand (fallback):** If the SHA isn't in the registry, the Worker wakes the builder
Machine via the Fly API, waits ~5s for it to start, sends the build request, and polls
KV for status. The builder runs the pipeline, callbacks the Worker, then stops itself.
The machine costs $0 while stopped.

Docker layer caching persists on the builder volume and in GitHub Actions cache,
so base layers are shared across builds.

---

## Cost breakdown

| Resource | Cost |
|---|---|
| Cloudflare Worker + KV | Free |
| GitHub Actions pre-builds | Free (public repo) |
| Builder Machine (only while building) | ~$0.02/hr × build time |
| Game machine (shared-cpu-1x, 512MB, 30 min) | ~$0.004/session |
| Fly registry storage | ~$0.02/GB/month |

The builder machine costs **$0 when stopped**. Without a cache volume every
on-demand build starts cold (~5-8 min), but pre-built release images (the
common path) are unaffected. Monthly total at low volume: roughly **$0.50-1/month**.
