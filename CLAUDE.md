# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

This repo launches ephemeral OpenFrontIO game server environments at specific git commits, so users can replay matches on the exact version they were played. Read `CLAUDE-instructions.md` for full architecture details and data flow.

## Development commands

### Fly Builder (`fly-builder/`)
```bash
npm start       # production (node src/index.js)
npm run dev     # watch mode (node --watch src/index.js)
```

### Cloudflare Worker (`worker/`)
```bash
wrangler dev    # local dev server
wrangler deploy # deploy to Cloudflare
```

### Deploy builder to Fly
```bash
fly deploy --config fly.builder.toml
```

There are no automated tests.

## Architecture summary

Three components + GitHub Actions:

1. **`worker/src/index.js`** — Cloudflare Worker. Serves the HTML UI, calls `https://api.openfront.io/public/game/{gameID}?turns=false` (SHA is `response.gitCommit`), checks production shortcut (latest release SHA cached in KV `__latest_release_sha__` for 15 min; production URL is `https://openfront.io/w{simpleHash(gameID)%20}/game/{gameID}`), wakes the builder machine, stores session state in KV with 3h TTL, receives callbacks at `POST /api/callback`.

2. **`fly-builder/src/index.js`** — Stopped Fly Machine (costs $0 idle). Started on demand by the Worker. On `POST /build`: checks registry for cached image → clones OpenFrontIO at SHA (requires `--recurse-submodules`) → builds → pushes → creates game machine in `openfront-games` → callbacks Worker → stops itself.

3. **`openfront-games` Fly app** — Shell app only; no deployments. Game machines are created/destroyed dynamically via Fly Machines API.

4. **`.github/workflows/prebuild-release.yml`** — Polls OpenFrontIO releases every 15 min; pre-builds images for new tags so the common case (matches on released versions) skips the builder entirely.

## Key implementation constraints

- Docker image ref pattern: `registry.fly.io/openfront-builder/openfront:<sha>`
- Registry check uses Docker v2 manifest API with Fly API token as Bearer
- OpenFrontIO clone must use `--recurse-submodules --shallow-submodules` (has a `gatekeeper` submodule)
- Builder reads `FLY_MACHINE_ID` / `FLY_APP_NAME` from Fly-injected env vars to stop itself
- `docker build` receives `GIT_COMMIT=<sha>` and `GAME_ENV=prod` as build args
- Production SHA check fails open — if GitHub is unreachable, the check is skipped

## Known gaps

See `CLAUDE-instructions.md` for open issues (orphaned machine cleanup, concurrent build concurrency).
