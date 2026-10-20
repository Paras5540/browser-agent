import dotenv from "dotenv";

// .env hi sach hai un keys ke liye jo UI se manage hoti hain — warna ambient
// env var (systemd, shell export) UI se saved key ko chupchap override kar deta hai.
// PORT/HOST ko jaan-boojh kar chhoda hai: CLI/systemd unhe jeetne deta hai.
const UI_MANAGED = [
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "HEADLESS",
  "MAX_STEPS",
  "DASHBOARD_PASSWORD",
  "USER_DATA_DIR",
];
try {
  const parsed = dotenv.parse(fs.readFileSync(path.resolve("./.env")));
  for (const k of UI_MANAGED) if (parsed[k] !== undefined) process.env[k] = parsed[k];
} catch {}
dotenv.config(); // baaki values bina override ke
import express from "express";
import path from "node:path";
import fs from "node:fs";
import cron from "node-cron";
import { store } from "./lib/store.js";
import { BrowserManager } from "./lib/browser.js";
import { runAgentTask } from "./lib/agent.js";
import { currentModel } from "./lib/llm.js";
import { publicSettings, saveSettings, testApiKey } from "./lib/config.js";

const PORT = Number(process.env.PORT || 3000);

// Password runtime pe padha jaata hai — UI se badalne par restart ki zaroorat nahi.
const dashPassword = () => process.env.DASHBOARD_PASSWORD || "";

// Key validation ka status (0 tokens — models list endpoint se check hota hai)
let keyStatus = { checked: false, ok: null, message: "not checked yet" };

async function refreshKeyStatus() {
  if (!publicSettings().hasKey) {
    keyStatus = { checked: true, ok: false, message: "API key set nahi hai" };
    return keyStatus;
  }
  const r = await testApiKey();
  keyStatus = { checked: true, ...r };
  console.log(`[key] ${r.ok ? "✓" : "✗"} ${r.message}`);
  return keyStatus;
}

const browser = new BrowserManager({
  userDataDir: process.env.USER_DATA_DIR || "./data/browser-profile",
});

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.resolve("./public")));
app.use("/outputs", express.static(path.resolve("./outputs")));

// ── optional password gate ────────────────────────────────────────────────────
app.use("/api", (req, res, next) => {
  const pw = dashPassword();
  if (!pw) return next();
  if (req.get("x-dash-key") === pw) return next();
  res.status(401).json({ error: "unauthorized" });
});

// ── one task at a time (single shared browser) ────────────────────────────────
let queue = Promise.resolve();
const active = new Map(); // runId -> { stop: () => void }

function enqueue(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

async function executeRun({ goal, source = "chat", scheduleId = null }) {
  const maxSteps = Number(store.getSettings().maxSteps) || Number(process.env.MAX_STEPS) || 45;
  const run = store.createRun({ goal, source, scheduleId });
  store.appendLog(run.id, { type: "start", text: goal });

  enqueue(async () => {
    try {
      const out = await runAgentTask({
        goal,
        browser,
        apiKey: process.env.GEMINI_API_KEY,
        maxSteps,
        onEvent: (e) => store.appendLog(run.id, e),
      });
      store.updateRun(run.id, {
        status: out.hitLimit ? "limit" : "done",
        result: out.result,
        finishedAt: new Date().toISOString(),
      });
      if (scheduleId) store.updateSchedule(scheduleId, { lastRun: new Date().toISOString(), lastStatus: "done" });
    } catch (err) {
      store.updateRun(run.id, {
        status: "error",
        error: String(err.message || err),
        finishedAt: new Date().toISOString(),
      });
      if (scheduleId) store.updateSchedule(scheduleId, { lastRun: new Date().toISOString(), lastStatus: "error" });
    } finally {
      active.delete(run.id);
    }
  });

  return run;
}

// ── API ───────────────────────────────────────────────────────────────────────

app.get("/api/state", (req, res) => {
  const db = store.all();
  res.json({
    ok: true,
    ...publicSettings(),
    keyStatus,
    maxSteps: Number(store.getSettings().maxSteps) || Number(process.env.MAX_STEPS) || 45,
    runs: db.runs.slice(0, 40).map((r) => ({
      id: r.id,
      goal: r.goal,
      status: r.status,
      result: r.result,
      error: r.error,
      source: r.source,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
      logCount: r.log.length,
    })),
    schedules: db.schedules,
    outputs: listOutputs(),
  });
});

// ── settings (UI se API key / model / headless) ──────────────────────────────

app.get("/api/settings", (req, res) => res.json(publicSettings()));

app.post("/api/settings/test", async (req, res) => {
  const result = await testApiKey(req.body?.apiKey);
  res.status(result.ok ? 200 : 400).json(result);
});

app.post("/api/settings", async (req, res) => {
  try {
    const before = publicSettings();
    const { changed } = saveSettings(req.body || {});

    // Model/headless badla to agla task nayi setting se chale.
    if (changed.includes("headless")) {
      await browser.close().catch(() => {});
    }
    if (changed.includes("apiKey")) await refreshKeyStatus();
    res.json({ ok: true, changed, settings: publicSettings(), keyStatus });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.post("/api/chat", async (req, res) => {
  const goal = String(req.body?.message || "").trim();
  if (!goal) return res.status(400).json({ error: "message required" });
  if (!publicSettings().hasKey) {
    return res.status(400).json({ error: "Pehle Settings tab me Gemini API key add karein" });
  }
  const run = await executeRun({ goal, source: "chat" });
  res.json({ ok: true, runId: run.id });
});

app.get("/api/run/:id", (req, res) => {
  const r = store.getRun(req.params.id);
  if (!r) return res.status(404).json({ error: "not found" });
  res.json(r);
});

app.post("/api/run/:id/stop", (req, res) => {
  // Best-effort: close the browser so the in-flight tool call fails fast.
  browser.close().finally(() => res.json({ ok: true }));
});

app.post("/api/schedules", (req, res) => {
  const { name, goal, cron: expr } = req.body || {};
  if (!goal || !expr) return res.status(400).json({ error: "goal and cron are required" });
  if (!cron.validate(expr)) return res.status(400).json({ error: "Invalid cron expression" });
  const s = store.createSchedule({
    name: (name || goal).slice(0, 60),
    goal,
    cron: expr,
  });
  reloadJobs();
  res.json({ ok: true, schedule: s });
});

app.patch("/api/schedules/:id", (req, res) => {
  const patch = req.body || {};
  if (patch.cron && !cron.validate(patch.cron)) {
    return res.status(400).json({ error: "Invalid cron expression" });
  }
  const s = store.updateSchedule(req.params.id, patch);
  if (!s) return res.status(404).json({ error: "not found" });
  reloadJobs();
  res.json({ ok: true, schedule: s });
});

app.delete("/api/schedules/:id", (req, res) => {
  store.deleteSchedule(req.params.id);
  reloadJobs();
  res.json({ ok: true });
});

app.post("/api/schedules/:id/run", async (req, res) => {
  const s = store.listSchedules().find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  const run = await executeRun({ goal: s.goal, source: "manual", scheduleId: s.id });
  res.json({ ok: true, runId: run.id });
});

app.get("/api/outputs", (req, res) => res.json({ outputs: listOutputs() }));

app.get("/api/outputs/:name", (req, res) => {
  const name = path.basename(req.params.name);
  res.download(path.join(path.resolve("./outputs"), name));
});

// ── cron ──────────────────────────────────────────────────────────────────────

let jobs = [];

function reloadJobs() {
  jobs.forEach((j) => j.stop());
  jobs = [];
  for (const s of store.listSchedules()) {
    if (!s.enabled || !cron.validate(s.cron)) continue;
    const job = cron.schedule(s.cron, () => {
      console.log(`[cron] firing schedule: ${s.name}`);
      executeRun({ goal: s.goal, source: "schedule", scheduleId: s.id }).catch((e) =>
        console.error("[cron] error", e)
      );
    });
    jobs.push(job);
    console.log(`[cron] scheduled "${s.name}" (${s.cron})`);
  }
}

function listOutputs() {
  const dir = path.resolve("./outputs");
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f !== ".gitkeep")
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, size: st.size, modified: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.modified < b.modified ? 1 : -1))
      .slice(0, 60);
  } catch {
    return [];
  }
}

app.listen(PORT, process.env.HOST || "0.0.0.0", () => {
  console.log(`\n  Browser Agent running  ->  http://${process.env.HOST || "localhost"}:${PORT}`);
  console.log(`  model: ${currentModel()}   headless: ${process.env.HEADLESS ?? "true"}`);
  if (!publicSettings().hasKey) {
    console.warn("  ⚠  Gemini API key set nahi hai — dashboard ke Settings tab se add karein\n");
  }
  reloadJobs();
  refreshKeyStatus();
});

process.on("SIGINT", async () => {
  console.log("\nshutting down…");
  await browser.close();
  process.exit(0);
});
