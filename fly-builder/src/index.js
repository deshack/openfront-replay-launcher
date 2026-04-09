/**
 * Builder app — runs on Fly.io as a persistent machine
 *
 * Responsibilities:
 *  1. Receive build requests from the Cloudflare Worker
 *  2. Check if a Docker image already exists in Fly's registry for that SHA
 *  3. If not: clone OpenFrontIO at that SHA, build, push to registry
 *  4. Create a Fly Machine in the games app from that image
 *  5. Callback the Worker with status updates
 *
 * Environment variables (set via fly secrets / fly.builder.toml [env]):
 *   CALLBACK_SECRET      Shared secret with the Worker
 *   FLY_API_TOKEN        Fly.io API token
 *   FLY_REGISTRY_APP     Fly app whose registry stores images (this app's name)
 *   FLY_GAMES_APP        Fly app that hosts game machines
 *   PORT                 (optional) defaults to 8080
 */

import express from "express";
import { spawn } from "child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import path from "path";
import os from "os";

const {
  CALLBACK_SECRET,
  FLY_API_TOKEN,
  FLY_REGISTRY_APP,
  FLY_GAMES_APP,
  PORT = "8080",
} = process.env;

const FLY_REGISTRY = "registry.fly.io";
const FLY_API = "https://api.machines.dev/v1";

const app = express();
app.use(express.json());

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireSecret(req, res, next) {
  const auth = req.headers["authorization"] ?? "";
  if (auth !== `Bearer ${CALLBACK_SECRET}`) return res.status(403).json({ error: "Forbidden" });
  next();
}

// ─── POST /build ──────────────────────────────────────────────────────────────

app.post("/build", requireSecret, async (req, res) => {
  const { matchId, sha, callbackOrigin } = req.body ?? {};
  if (!matchId || !sha || !callbackOrigin) {
    return res.status(400).json({ error: "matchId, sha, callbackOrigin required" });
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    return res.status(400).json({ error: "sha must be a 40-character lowercase hex string" });
  }

  // Respond immediately — build is async
  res.json({ ok: true, message: "Build started" });

  runPipeline({ matchId, sha, callbackOrigin }).catch(async (e) => {
    console.error(`[${matchId}] Pipeline failed:`, e.message);
    await callback(callbackOrigin, { matchId, status: "error", error: e.message });
  });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(Number(PORT), () => console.log(`Builder listening on :${PORT}`));

// ─── Pipeline ─────────────────────────────────────────────────────────────────

async function runPipeline({ matchId, sha, callbackOrigin }) {
  const log = (msg) => console.log(`[${matchId}] ${msg}`);
  const cb = (patch) => callback(callbackOrigin, { matchId, ...patch });

  const imageRef = `${FLY_REGISTRY}/${FLY_REGISTRY_APP}/openfront:${sha}`;

  try {
    // 1. Check registry
    log(`Checking registry for ${imageRef}`);
    const exists = await imageExistsInRegistry(imageRef);

    if (exists) {
      log("Image found in registry — skipping build");
    } else {
      // 2. Clone + build + push
      log("Image not found — starting build");
      await cb({ status: "building" });
      await buildAndPush({ matchId, sha, imageRef, log });
    }

    // 3. Create Fly Machine
    log("Creating Fly Machine");
    await cb({ status: "launching" });

    const machine = await createMachine({ matchId, sha, imageRef });
    log(`Machine created: ${machine.id}`);

    // 4. Wait for machine to start
    await waitForMachine(machine.id);
    log(`Machine started`);

    const url = `https://${FLY_GAMES_APP}.fly.dev`;
    await cb({ status: "ready", url, machineId: machine.id });
    log(`Done — ${url}`);
  } finally {
    // Always stop this builder machine when done, whether success or failure.
    // The Worker will start it again next time it's needed.
    log("Stopping builder machine...");
    await stopSelf();
  }
}

// ─── Self-stop ────────────────────────────────────────────────────────────────
// Asks the Fly API to stop this machine. We read the machine ID from the
// FLY_MACHINE_ID env var that Fly injects automatically at runtime.

async function stopSelf() {
  const machineId = process.env.FLY_MACHINE_ID;
  const appName = process.env.FLY_APP_NAME;
  if (!machineId || !appName) {
    console.warn("FLY_MACHINE_ID / FLY_APP_NAME not set — cannot self-stop");
    return;
  }
  try {
    await fetch(`${FLY_API}/apps/${appName}/machines/${machineId}/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${FLY_API_TOKEN}` },
    });
    console.log(`Builder machine ${machineId} stop requested.`);
  } catch (e) {
    console.error("Self-stop failed:", e.message);
  }
}

// ─── Docker: check registry ───────────────────────────────────────────────────

async function imageExistsInRegistry(imageRef) {
  try {
    // Parse registry/app/name:tag to query the registry API
    // registry.fly.io/<app>/openfront:<sha>
    const matchResult = imageRef.replace(`${FLY_REGISTRY}/`, "").match(/^(.+):(.+)$/);
    if (!matchResult) {
      console.error(`Cannot parse imageRef: ${imageRef}`);
      return false;
    }
    const [, appAndName, tag] = matchResult;
    const [registryApp, imageName] = appAndName.split("/");

    const res = await fetch(
      `https://${FLY_REGISTRY}/v2/${registryApp}/${imageName}/manifests/${tag}`,
      {
        headers: {
          Authorization: `Bearer ${FLY_API_TOKEN}`,
          Accept: "application/vnd.docker.distribution.manifest.v2+json",
        },
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Docker: build + push ─────────────────────────────────────────────────────

async function buildAndPush({ matchId, sha, imageRef, log }) {
  const workDir = path.join(os.tmpdir(), `openfront-${matchId}`);
  try {
    // Clone OpenFrontIO at specific SHA with submodules
    log(`Cloning OpenFrontIO @ ${sha}`);
    mkdirSync(workDir, { recursive: true });

    await streamExec("git", [
      "clone",
      "--recurse-submodules",
      "--shallow-submodules",
      "https://github.com/openfrontio/OpenFrontIO.git",
      workDir,
    ], {}, log, 5 * 60 * 1000);

    await streamExec("git", ["-C", workDir, "fetch", "--depth=1", "origin", sha], {}, log, 3 * 60 * 1000);
    await streamExec("git", ["-C", workDir, "checkout", sha], {}, log, 60 * 1000);
    await streamExec("git", ["-C", workDir, "submodule", "update", "--init", "--recursive"], {}, log, 5 * 60 * 1000);

    // Log in to Fly registry — use spawn with stdin pipe to avoid shell interpolation
    log("Logging in to Fly registry");
    await new Promise((resolve, reject) => {
      const proc = spawn("docker", ["login", FLY_REGISTRY, "--username", "x", "--password-stdin"], {
        stdio: ["pipe", "inherit", "inherit"],
      });
      proc.stdin.write(FLY_API_TOKEN);
      proc.stdin.end();
      proc.on("close", code => code === 0 ? resolve() : reject(new Error(`docker login exited ${code}`)));
    });

    // Build using OpenFrontIO's own Dockerfile, injecting required build args
    log(`Building Docker image`);
    await streamExec("docker", [
      "build",
      "--tag", imageRef,
      "--build-arg", `GIT_COMMIT=${sha}`,
      "--build-arg", "GAME_ENV=prod",
      workDir,
    ], {}, log, 20 * 60 * 1000);

    // Push
    log(`Pushing ${imageRef}`);
    await streamExec("docker", ["push", imageRef], {}, log, 10 * 60 * 1000);

    // Prune dangling images to reclaim disk
    await streamExec("docker", ["image", "prune", "-f"], {}, log, 60 * 1000);
  } finally {
    // Clean up clone
    rmSync(workDir, { recursive: true, force: true });
  }
}

// ─── Fly Machines API ─────────────────────────────────────────────────────────

async function createMachine({ matchId, sha, imageRef }) {
  const res = await flyApi("POST", `/apps/${FLY_GAMES_APP}/machines`, {
    name: `game-${sha.slice(0, 7)}-${Date.now()}`,
    config: {
      image: imageRef,
      auto_destroy: true,
      guest: { cpu_kind: "shared", cpus: 1, memory_mb: 512 },
      services: [
        {
          // OpenFrontIO's nginx listens on 80 inside the container
          internal_port: 80,
          protocol: "tcp",
          ports: [
            { port: 443, handlers: ["tls", "http"] },
            { port: 80, handlers: ["http"] },
          ],
          autostop: true,
          autostart: true,
          min_machines_running: 0,
        },
      ],
      env: {
        GAME_ENV: "prod",
        GIT_COMMIT: sha,
      },
      metadata: { match_id: matchId, commit_sha: sha },
    },
  });
  return res;
}

async function waitForMachine(machineId, timeoutMs = 5 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = await flyApi("GET", `/apps/${FLY_GAMES_APP}/machines/${machineId}`);
    if (m.state === "started") return m;
    if (["failed", "destroyed"].includes(m.state)) throw new Error(`Machine ${machineId} entered state: ${m.state}`);
    await sleep(3000);
  }
  throw new Error(`Machine ${machineId} did not start within ${timeoutMs / 1000}s`);
}

async function flyApi(method, path, body) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${FLY_API_TOKEN}`,
      "Content-Type": "application/json",
    },
  };
  if (body && method !== "GET") opts.body = JSON.stringify(body);
  const res = await fetch(`${FLY_API}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fly API ${method} ${path} → ${res.status}: ${text}`);
  }
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Fly API ${method} ${path} returned invalid JSON: ${text?.slice(0, 200)}`);
  }
}

// ─── Callback to Worker ───────────────────────────────────────────────────────

async function callback(origin, body, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${origin}/api/callback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CALLBACK_SECRET}`,
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return;
      console.error(`[callback] Attempt ${attempt} failed: HTTP ${res.status}`);
    } catch (e) {
      console.error(`[callback] Attempt ${attempt} error:`, e.message);
    }
    if (attempt < retries) await sleep(attempt * 1000);
  }
  console.error(`[callback] All ${retries} attempts failed for status="${body.status}"`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function streamExec(cmd, args, opts, onLog, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`${cmd} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    proc.stdout.on("data", d => d.toString().split("\n").filter(Boolean).forEach(onLog));
    proc.stderr.on("data", d => d.toString().split("\n").filter(Boolean).forEach(onLog));
    proc.on("close", code => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
