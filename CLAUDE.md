# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

This repo launches ephemeral OpenFrontIO game server environments at specific git commits, so users can replay matches on the exact version they were played. Read `CLAUDE-instructions.md` for full architecture details and data flow.

## Development commands

### Cloudflare Worker (`worker/`)
```bash
wrangler dev    # local dev server
wrangler deploy # deploy to Cloudflare
```

There are no automated tests.

## Architecture summary

Two components + GitHub Actions:

1. **`worker/src/index.js`** — Cloudflare Worker. Serves the HTML UI, calls `https://api.openfront.io/public/game/{gameID}?turns=false` (SHA is `response.gitCommit`), checks production shortcut (latest release SHA cached in KV `__latest_release_sha__` for 15 min; production URL is `https://openfront.io/w{simpleHash(gameID)%20}/game/{gameID}`), checks Fly registry for a pre-built image, creates a game Machine directly via the Fly Machines API, stores session state in KV with 3h TTL, polls machine state on `GET /api/status/:matchId`.

2. **`openfront-games` Fly app** — Shell app only; no deployments. Game machines are created/destroyed dynamically via Fly Machines API. `auto_destroy: true` is set on each machine.

3. **`.github/workflows/prebuild-release.yml`** — Polls OpenFrontIO releases daily; pre-builds images for new tags and pushes to `registry.fly.io/openfront-games/openfront:<sha>`.

## Key implementation constraints

- Docker image ref pattern: `registry.fly.io/openfront-games/openfront:<sha>`
- Registry check uses Docker v2 manifest API with Fly API token as Bearer
- If no pre-built image exists for a SHA, returns `{ status: "unavailable" }` — no on-demand build path
- `FLY_REGISTRY_APP` is a `[vars]` entry in `wrangler.toml` (not a secret)
- Production SHA check fails open — if GitHub is unreachable, the check is skipped
- KV TTL minimum is 60 seconds (Cloudflare enforces this)

## Known gaps

See `CLAUDE-instructions.md` for open issues (orphaned machine cleanup, concurrent launch concurrency).
