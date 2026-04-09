/**
 * Cloudflare Worker — OpenFrontIO Ephemeral Launcher
 *
 * KV namespace binding:  SESSIONS   (key: matchId, value: JSON session)
 * Var bindings (set in wrangler.toml [vars]):
 *   GHCR_OWNER              GitHub username/org that owns the ghcr.io packages  (e.g. "deshack")
 * Secret bindings (set via wrangler secret put):
 *   FLY_API_TOKEN           Fly.io API token
 *   FLY_GAMES_APP           Fly app name for game machines    (e.g. "openfront-games")
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS for local dev
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const respond = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...cors },
      });

    const { pathname } = url;

    if (request.method === "GET" && pathname === "/") return serveUI();
    if (request.method === "POST" && pathname === "/api/launch") return handleLaunch(request, env, respond);
    if (request.method === "GET"  && pathname.startsWith("/api/status/")) return handleStatus(request, env, respond);
    if (request.method === "DELETE" && pathname.startsWith("/api/session/")) return handleDelete(request, env, respond);
    if (pathname.startsWith("/game/")) return handleGameProxy(request, env);

    return new Response("Not found", { status: 404 });
  },
};

// ─── POST /api/launch ─────────────────────────────────────────────────────────

async function handleLaunch(request, env, respond) {
  const { matchId } = await request.json().catch(() => ({}));
  if (!matchId) return respond({ error: "matchId is required" }, 400);

  // Return existing live session
  const existing = await getSession(env, matchId);
  if (existing && !["error", "stopped", "unavailable"].includes(existing.status)) {
    return respond({ matchId, status: existing.status, url: existing.url, sha: existing.sha });
  }

  // Fetch commit SHA from match API
  let sha;
  try {
    const r = await fetch(`https://api.openfront.io/public/game/${matchId}?turns=false`);
    if (!r.ok) throw new Error(`Match API ${r.status}`);
    const data = await r.json();
    sha = data.gitCommit;
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("Invalid or missing gitCommit in match API response");
  } catch (e) {
    return respond({ error: `Match lookup failed: ${e.message}` }, 502);
  }

  // Check whether this SHA is the latest released version.
  // If so, the production environment already handles it — no ephemeral env needed.
  const latestSha = await fetchLatestReleaseSha(env);
  if (latestSha && sha === latestSha) {
    return respond({ matchId, sha, status: "production", url: gameUrl(matchId) });
  }

  // Check if a pre-built image exists for this SHA
  if (!await imageExistsInRegistry(env, sha)) {
    return respond({
      matchId, sha, status: "unavailable",
      error: "No pre-built image for this game version. Only released versions can be replayed.",
    });
  }

  const imageRef = `ghcr.io/${env.GHCR_OWNER}/openfront-replay-launcher:${sha}`;
  let machine;
  try {
    machine = await createMachine(env, { matchId, sha, imageRef });
  } catch (e) {
    return respond({ error: `Failed to create game machine: ${e.message}` }, 502);
  }

  const session = {
    matchId, sha,
    status: "launching",
    url: null,
    machineId: machine.id,
    error: null,
    createdAt: Date.now(),
  };
  await putSession(env, matchId, session);
  return respond({ matchId, status: "launching", sha });
}

// ─── Fetch latest OpenFrontIO release SHA ─────────────────────────────────────
// Cached in KV for 15 minutes to avoid hammering the GitHub API on every launch.

async function fetchLatestReleaseSha(env) {
  const CACHE_KEY = "__latest_release_sha__";
  const CACHE_TTL = 60 * 15; // 15 minutes

  // Try cache first
  const cached = await env.SESSIONS.get(CACHE_KEY);
  if (cached) return cached;

  try {
    // Get latest release tag
    const releaseRes = await fetch(
      "https://api.github.com/repos/openfrontio/OpenFrontIO/releases/latest",
      { headers: { "User-Agent": "openfront-launcher" } }
    );
    if (!releaseRes.ok) return null;
    const { tag_name } = await releaseRes.json();
    if (!tag_name) return null;

    // Resolve tag → SHA (handling both lightweight and annotated tags)
    const refRes = await fetch(
      `https://api.github.com/repos/openfrontio/OpenFrontIO/git/refs/tags/${tag_name}`,
      { headers: { "User-Agent": "openfront-launcher" } }
    );
    if (!refRes.ok) return null;
    const ref = await refRes.json();

    let sha = ref.object.sha;

    // Annotated tags point to a tag object, not the commit directly
    if (ref.object.type === "tag") {
      const tagRes = await fetch(
        `https://api.github.com/repos/openfrontio/OpenFrontIO/git/tags/${sha}`,
        { headers: { "User-Agent": "openfront-launcher" } }
      );
      if (!tagRes.ok) return null;
      const tag = await tagRes.json();
      sha = tag.object.sha;
    }

    // Cache the resolved SHA
    await env.SESSIONS.put(CACHE_KEY, sha, { expirationTtl: CACHE_TTL });
    return sha;
  } catch {
    return null; // fail open — don't block launches if GitHub is unreachable
  }
}

// ─── GET /api/status/:matchId ─────────────────────────────────────────────────

async function handleStatus(request, env, respond) {
  const matchId = new URL(request.url).pathname.split("/").pop();
  const session = await getSession(env, matchId);
  if (!session) return respond({ error: "Session not found" }, 404);

  if (session.status === "launching" && session.machineId) {
    try {
      const machine = await flyApi(env, "GET",
        `/apps/${env.FLY_GAMES_APP}/machines/${session.machineId}`);
      if (machine.state === "started") {
        const url = `${new URL(request.url).origin}/game/${matchId}`;
        const updated = { ...session, status: "ready", url };
        await putSession(env, matchId, updated);
        return respond(updated);
      }
      if (["failed", "destroyed"].includes(machine.state)) {
        const updated = { ...session, status: "error",
          error: `Machine entered state: ${machine.state}` };
        await putSession(env, matchId, updated);
        return respond(updated);
      }
    } catch { /* fail open — return stale session */ }
  }

  return respond(session);
}

// ─── DELETE /api/session/:matchId ─────────────────────────────────────────────

async function handleDelete(request, env, respond) {
  const matchId = new URL(request.url).pathname.split("/").pop();
  const session = await getSession(env, matchId);
  if (!session) return respond({ error: "Not found" }, 404);

  if (session.machineId) {
    await destroyMachine(env, session.machineId).catch((e) => console.error("destroyMachine failed:", e.message));
  }
  await putSession(env, matchId, { ...session, status: "stopped", url: null, machineId: null });
  return respond({ ok: true });
}

// ─── KV helpers ───────────────────────────────────────────────────────────────

async function getSession(env, matchId) {
  const raw = await env.SESSIONS.get(matchId);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function putSession(env, matchId, session) {
  // TTL: 3 hours
  await env.SESSIONS.put(matchId, JSON.stringify(session), { expirationTtl: 60 * 60 * 3 });
}

// ─── Fly API helper ───────────────────────────────────────────────────────────

async function flyApi(env, method, path, body) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${env.FLY_API_TOKEN}`, "Content-Type": "application/json" },
  };
  if (body && method !== "GET") opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.machines.dev/v1${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fly API ${method} ${path} → ${res.status}: ${text}`);
  }
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; }
  catch { throw new Error(`Fly API ${method} ${path} returned invalid JSON`); }
}

// ─── ghcr.io registry check ───────────────────────────────────────────────────

async function imageExistsInRegistry(env, sha) {
  try {
    // Get anonymous pull token (works for public packages)
    const tokenRes = await fetch(
      `https://ghcr.io/token?service=ghcr.io&scope=repository:${env.GHCR_OWNER}/openfront-replay-launcher:pull`
    );
    if (!tokenRes.ok) {
      console.error("ghcr.io anonymous pull token fetch failed:", tokenRes.status, tokenRes.statusText);
      return false;
    }
    const { token } = await tokenRes.json();
    const res = await fetch(
      `https://ghcr.io/v2/${env.GHCR_OWNER}/openfront-replay-launcher/manifests/${sha}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.index.v1+json",
        },
      }
    );

    console.debug("ghcr.io manifest check for sha:", sha, res.status, res.statusText);

    return res.ok;
  } catch { return false; }
}

// ─── Fly Machines API ─────────────────────────────────────────────────────────

async function createMachine(env, { matchId, sha, imageRef }) {
  return flyApi(env, "POST", `/apps/${env.FLY_GAMES_APP}/machines`, {
    name: `game-${sha.slice(0, 7)}-${Date.now()}`,
    config: {
      image: imageRef,
      auto_destroy: true,
      guest: { cpu_kind: "shared", cpus: 1, memory_mb: 512 },
      services: [{
        internal_port: 80,
        protocol: "tcp",
        ports: [
          { port: 443, handlers: ["tls", "http"] },
          { port: 80, handlers: ["http"] },
        ],
        autostop: true,
        autostart: true,
        min_machines_running: 0,
      }],
      env: { GAME_ENV: "prod", GIT_COMMIT: sha },
      metadata: { match_id: matchId, commit_sha: sha },
    },
  });
}

async function destroyMachine(env, machineId) {
  const path = `/apps/${env.FLY_GAMES_APP}/machines/${machineId}`;
  await flyApi(env, "POST", `${path}/stop`).catch(() => {});
  // Poll until stopped before issuing DELETE (up to 10s)
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const m = await flyApi(env, "GET", path).catch(() => null);
    if (!m || m.state === "stopped" || m.state === "destroyed") break;
    await new Promise(r => setTimeout(r, 1000));
  }
  await flyApi(env, "DELETE", `${path}?kill=true`);
}

// ─── Production game URL ──────────────────────────────────────────────────────
// Matches the gameUrl() logic from the OpenFrontIO client — routes to one of
// 20 worker subdomains based on a hash of the game ID.

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function gameUrl(gameID) {
  const workerIndex = simpleHash(gameID) % 20;
  return `https://openfront.io/w${workerIndex}/game/${gameID}`;
}

// ─── Game proxy ───────────────────────────────────────────────────────────────
// Routes /game/:matchId/* requests to the correct Fly Machine via the fly-replay
// header, ensuring each user lands on their specific game instance rather than
// being load-balanced to a random machine in the openfront-games app.
// HTMLRewriter injects <base href> so relative asset paths stay on this proxy.

async function handleGameProxy(request, env) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/game\/([^/]+)(\/.*)?$/);
  if (!match) return new Response("Not found", { status: 404 });

  const [, matchId, subPath = "/"] = match;
  const session = await getSession(env, matchId);
  if (!session?.machineId) {
    return new Response("Game session not found or not ready", { status: 404 });
  }

  const targetUrl = `https://${env.FLY_GAMES_APP}.fly.dev${subPath}${url.search}`;
  const headers = new Headers(request.headers);
  headers.set("fly-replay", `instance=${session.machineId}`);

  const response = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "follow",
  });

  // For HTML responses, inject <base href> so relative asset URLs continue to
  // route through this proxy (and thus carry the fly-replay header).
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    return new HTMLRewriter()
      .on("head", {
        element(el) {
          el.prepend(`<base href="/game/${matchId}/">`, { html: true });
        },
      })
      .transform(response);
  }

  return response;
}

// ─── UI ───────────────────────────────────────────────────────────────────────

function serveUI() {
  return new Response(HTML, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>OpenFrontIO — Match Launcher</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=Space+Grotesk:wght@300;500;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#07090d;--panel:#0e1318;--border:#1c2830;
  --accent:#39e8a0;--accent-dim:rgba(57,232,160,.1);
  --warn:#f59e0b;--err:#f43f5e;--text:#d4e4ef;--muted:#3d5466;
  --mono:'IBM Plex Mono',monospace;--sans:'Space Grotesk',sans-serif;
}
body{background:var(--bg);color:var(--text);font-family:var(--sans);
  min-height:100vh;display:grid;place-items:center;padding:1.5rem;}
body::before{content:'';position:fixed;inset:0;
  background-image:linear-gradient(rgba(57,232,160,.02) 1px,transparent 1px),
    linear-gradient(90deg,rgba(57,232,160,.02) 1px,transparent 1px);
  background-size:48px 48px;pointer-events:none;}
.shell{width:100%;max-width:560px;position:relative;z-index:1;}
.shell::before{content:'';display:block;height:2px;
  background:linear-gradient(90deg,transparent,var(--accent) 40%,transparent);}
.card{background:var(--panel);border:1px solid var(--border);border-top:none;
  padding:2.5rem 2.5rem 2rem;}
.eyebrow{font-family:var(--mono);font-size:.62rem;letter-spacing:.2em;
  color:var(--accent);text-transform:uppercase;margin-bottom:1rem;opacity:.7;}
h1{font-size:1.7rem;font-weight:700;letter-spacing:-.03em;color:#fff;margin-bottom:.3rem;}
.sub{font-size:.875rem;color:var(--muted);font-weight:300;margin-bottom:2.25rem;}
label{font-family:var(--mono);font-size:.62rem;letter-spacing:.12em;
  color:var(--muted);display:block;margin-bottom:.45rem;}
input{width:100%;background:#0a0f14;border:1px solid var(--border);border-radius:2px;
  padding:.75rem 1rem;font-family:var(--mono);font-size:.95rem;color:#fff;outline:none;
  transition:border-color .15s,box-shadow .15s;}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(57,232,160,.08);}
input::placeholder{color:var(--muted);}
.btn{margin-top:1.25rem;width:100%;padding:.8rem;background:var(--accent);color:#020c06;
  border:none;border-radius:2px;font-family:var(--sans);font-weight:700;font-size:.9rem;
  letter-spacing:.03em;cursor:pointer;transition:opacity .15s,transform .1s;}
.btn:hover:not(:disabled){opacity:.85;}
.btn:active:not(:disabled){transform:scale(.99);}
.btn:disabled{opacity:.3;cursor:not-allowed;}
.status-wrap{margin-top:1.75rem;display:none;}
.status-wrap.show{display:block;}
.status-header{display:flex;align-items:center;gap:.6rem;margin-bottom:1rem;}
.dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;background:var(--muted);transition:background .3s;}
.dot.launching{animation:blink 1.1s ease-in-out infinite;background:#60a5fa;}
.dot.ready{background:var(--accent);}
.dot.production{background:#a78bfa;}
.dot.error{background:var(--err);}
.dot.unavailable{background:var(--muted);}
@keyframes blink{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.3;transform:scale(.6);}}
.status-text{font-family:var(--mono);font-size:.8rem;color:var(--text);}
.meta{display:flex;gap:1.5rem;flex-wrap:wrap;margin-top:1rem;}
.meta-item{display:flex;flex-direction:column;gap:.2rem;}
.meta-label{font-family:var(--mono);font-size:.58rem;letter-spacing:.12em;
  color:var(--muted);text-transform:uppercase;}
.meta-value{font-family:var(--mono);font-size:.78rem;color:var(--text);}
.go-btn{display:none;margin-top:1.25rem;width:100%;padding:.75rem;background:transparent;
  border:1px solid var(--accent);color:var(--accent);border-radius:2px;
  font-family:var(--mono);font-size:.82rem;cursor:pointer;
  text-align:center;text-decoration:none;transition:background .15s;}
.go-btn.show{display:block;}
.go-btn:hover{background:var(--accent-dim);}
</style>
</head>
<body>
<div class="shell">
  <div class="card">
    <div class="eyebrow">OpenFront Replay Launcher</div>
    <h1>Launch Match Environment</h1>
    <p class="sub">Runs the exact game version a match was played on.</p>
    <label for="mid">Game ID</label>
    <input id="mid" type="text" placeholder="e.g. match_a1b2c3d4" autocomplete="off" spellcheck="false"/>
    <button class="btn" id="btn" onclick="launch()">Launch Environment</button>
    <div class="status-wrap" id="sw">
      <div class="status-header">
        <div class="dot" id="dot"></div>
        <span class="status-text" id="st">Initializing...</span>
      </div>
      <div class="meta" id="meta"></div>
      <a class="go-btn" id="go" target="_blank" rel="noopener">Open Game Environment →</a>
    </div>
  </div>
</div>
<script>
let poll;
const INITIAL_DELAY  = 18_000;  // wait before first poll — machine takes ~20s
const RETRY_INTERVAL = 2_000;   // fast retry cadence once we start checking
const RETRY_PHASE    = 10_000;  // fast retry window after INITIAL_DELAY
const BACKOFF_MULT   = 1.5;
const MAX_INTERVAL   = 30_000;
const POLL_TIMEOUT   = 180_000; // 3 minutes — give up after this

const labels = {
  launching:   'Starting game environment\u2026',
  ready:       'Environment ready!',
  production:  'This match runs on the current production version.',
  unavailable: 'No pre-built image for this version \u2014 only released games can be replayed.',
  error:       'Something went wrong.',
  stopped:     'Environment stopped.',
};

async function launch() {
  const matchId = document.getElementById('mid').value.trim();
  if (!matchId) return;
  clearTimeout(poll);
  document.getElementById('btn').disabled = true;
  document.getElementById('sw').className = 'status-wrap show';
  document.getElementById('meta').innerHTML = '';
  document.getElementById('go').className = 'go-btn';
  setStatus('launching', 'Contacting match API\u2026');

  const res = await fetch('/api/launch', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({matchId}),
  }).catch(e => { setStatus('error', e.message); return null; });
  if (!res) return;

  const data = await res.json();
  if (data.error) { setStatus('error', data.error); document.getElementById('btn').disabled=false; return; }

  setMeta(matchId, data.sha);

  // Match is on the latest release — send straight to production
  if (data.status === 'production' && data.url) return handleProduction(data.url);

  // Already ready (cached session)
  if (data.status === 'ready' && data.url) return handleReady(data.url);

  // No pre-built image for this SHA
  if (data.status === 'unavailable') {
    setStatus('unavailable', labels.unavailable);
    document.getElementById('btn').disabled = false;
    return;
  }

  // Poll for status — wait for expected start time, then retry quickly, then back off
  let pollStart = Date.now();
  let backoffDelay = RETRY_INTERVAL;

  function scheduleNext() {
    const elapsed = Date.now() - pollStart;
    if (elapsed >= POLL_TIMEOUT) {
      setStatus('error', 'Timed out waiting for environment to start.');
      document.getElementById('btn').disabled = false;
      return;
    }
    let delay;
    if (elapsed < INITIAL_DELAY) {
      delay = INITIAL_DELAY - elapsed;
    } else if (elapsed < INITIAL_DELAY + RETRY_PHASE) {
      delay = RETRY_INTERVAL;
    } else {
      backoffDelay = Math.min(backoffDelay * BACKOFF_MULT, MAX_INTERVAL);
      delay = backoffDelay;
    }
    poll = setTimeout(doPoll, delay);
  }

  async function doPoll() {
    const s = await fetch(\`/api/status/\${encodeURIComponent(matchId)}\`).then(r=>r.json()).catch(()=>null);
    if (!s) { scheduleNext(); return; }
    setStatus(s.status, labels[s.status] ?? s.status);
    if (s.status === 'ready' && s.url) { handleReady(s.url); return; }
    if (s.status === 'error') { document.getElementById('btn').disabled=false; return; }
    scheduleNext();
  }

  scheduleNext();
}

function handleProduction(url) {
  setStatus('production', 'This match runs on the current production version.');
  const go = document.getElementById('go');
  go.href = url;
  go.textContent = 'Open in Production \u2192';
  go.className = 'go-btn show';
  document.getElementById('btn').disabled = false;
  setTimeout(() => window.open(url, '_blank'), 1200);
}

function handleReady(url) {
  const go = document.getElementById('go');
  go.href = url;
  go.textContent = 'Open Game Environment \u2192';
  go.className = 'go-btn show';
  document.getElementById('btn').disabled = false;
  setTimeout(() => window.open(url, '_blank'), 1200);
}

function setStatus(state, text) {
  document.getElementById('dot').className = 'dot ' + state;
  document.getElementById('st').textContent = text;
}

function setMeta(matchId, sha) {
  document.getElementById('meta').innerHTML = \`
    <div class="meta-item"><span class="meta-label">Match</span><span class="meta-value">\${matchId}</span></div>
    <div class="meta-item"><span class="meta-label">Commit</span><span class="meta-value">\${(sha||'').slice(0,12)}</span></div>\`;
}

document.getElementById('mid').addEventListener('keydown', e => { if(e.key==='Enter') launch(); });
</script>
</body>
</html>`;
