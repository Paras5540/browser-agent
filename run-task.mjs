#!/usr/bin/env node
/**
 * Ek single task chala kar result file me likhta hai.
 * GitHub Actions me chalne par issue pe LIVE progress comment bhi update karta hai.
 *
 * Env:
 *   GEMINI_API_KEY      (required)
 *   TASK_GOAL           (optional — warna CLI arg ya tasks/scheduled.txt)
 *   GITHUB_TOKEN        (optional — live comment ke liye)
 *   ISSUE_NUMBER        (optional — live comment ke liye)
 *   GITHUB_REPOSITORY   (Actions automatically deta hai)
 */
import fs from "node:fs";
import path from "node:path";
import { BrowserManager } from "./lib/browser.js";
import { runAgentTask } from "./lib/agent.js";

const OUTPUTS = path.resolve("./outputs");
fs.mkdirSync(OUTPUTS, { recursive: true });

const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const GH_REPO = process.env.GITHUB_REPOSITORY || "";
const ISSUE = process.env.ISSUE_NUMBER || "";
const REPO = process.env.GITHUB_REPOSITORY || "";

function resolveGoal() {
  const fromEnv = (process.env.TASK_GOAL || "").trim();
  if (fromEnv) return fromEnv;
  const fromArgs = process.argv.slice(2).join(" ").trim();
  if (fromArgs) return fromArgs;
  for (const f of ["tasks/scheduled.txt", "tasks/scheduled.md"]) {
    try {
      const t = fs.readFileSync(f, "utf8").trim();
      if (t) return t;
    } catch {}
  }
  return "";
}

const goal = resolveGoal();
if (!goal) {
  console.error("✗ Koi task nahi mila. TASK_GOAL env, CLI arg, ya tasks/scheduled.txt dein.");
  process.exit(1);
}
const PROVIDER = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
const LLM_KEY = (process.env.LLM_API_KEY || "").trim();
const GEMINI_KEYS = [process.env.GEMINI_API_KEY, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3, process.env.GEMINI_KEY_4]
  .map((k) => (k || "").trim())
  .filter(Boolean);

const API_KEYS = PROVIDER === "openai" ? (LLM_KEY ? [LLM_KEY] : []) : GEMINI_KEYS;
const API_KEY_MAIN = API_KEYS[0];

if (!API_KEYS.length) {
  console.error(
    PROVIDER === "openai"
      ? "✗ LLM_API_KEY set nahi hai (Groq key) — Repo → Settings → Secrets → LLM_API_KEY"
      : "✗ GEMINI_API_KEY set nahi hai — Repo → Settings → Secrets → GEMINI_API_KEY"
  );
  process.exit(1);
}

// ── live progress comment ────────────────────────────────────────────────────
const canComment = Boolean(GH_TOKEN && ISSUE && REPO);
let commentId = null;
let lastPush = 0;
let finalized = false;      // final result likh diya → progress update band
let inflight = Promise.resolve();
const timeline = [];
const startedAt = Date.now();

const elapsed = () => {
  const s = Math.round((Date.now() - startedAt) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

const HUMAN = {
  search: (a) => `web pe dhoondh raha hoon — "${a.query || ""}"`,
  navigate: (a) => `khol raha hoon — ${String(a.url || "").replace(/^https?:\/\//, "").slice(0, 60)}`,
  elements: () => "page ke buttons aur links dekh raha hoon",
  click: (a) => `click kar raha hoon — ${String(a.text || a.selector || (a.index !== undefined ? `[${a.index}]` : "")).slice(0, 50)}`,
  type: (a) => `likh raha hoon — "${String(a.text || "").slice(0, 40)}"`,
  press: (a) => `${a.key || "Enter"} dabaa raha hoon`,
  scroll: (a) => `scroll kar raha hoon ${a.direction === "up" ? "upar" : "neeche"}`,
  back: () => "pichle page pe jaa raha hoon",
  forward: () => "aage ke page pe jaa raha hoon",
  wait: () => "intezaar kar raha hoon",
  read_page: () => "page ka content padh raha hoon",
  extract: (a) => `data nikaal raha hoon — ${String(a.selector || "").slice(0, 40)}`,
  tabs: (a) => `tabs manage kar raha hoon (${a.action || "list"})`,
  screenshot: () => "screen dekh raha hoon",
  save_results: (a) => `file bana raha hoon — ${String(a.filename || "result")}`,
  note: () => "progress note save kar raha hoon",
  read_notes: () => "apne purane notes padh raha hoon",
  finish: () => "kaam khatam kar raha hoon",
};

function renderProgress() {
  const lines = timeline.slice(-22).map((e) => {
    if (e.type === "tool") return `- ✓ ${e.human || e.name}`;
    if (e.type === "tool_error") return `- ✗ ${e.human || e.name} — ${e.detail}`;
    return `- 💬 ${e.detail}`;
  });
  const lastTool = [...timeline].reverse().find((t) => t.type === "tool" || t.type === "tool_error");
  const current = lastTool?.human || "shuru kar raha hoon…";
  return [
    "### ◐ Agent chal raha hai…",
    "",
    `**Task:** ${goal.split("\n")[0].slice(0, 160)}`,
    `**Abhi:** ${current}`,
    `**Elapsed:** ${elapsed()} · **Steps:** ${timeline.filter((t) => t.type === "tool").length}`,
    "",
    lines.length ? lines.join("\n") : "_shuru ho raha hai…_",
    "",
    `<sub>live update · ${new Date().toISOString()}</sub>`,
  ].join("\n");
}

async function ghApi(method, url, body) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "browser-agent",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.ok ? res.json().catch(() => null) : null;
}

function pushProgress(force = false) {
  if (!canComment || finalized) return inflight;
  // queue me daalo taaki final result ke baad koi purana update na aaye
  inflight = inflight
    .then(async () => {
      if (finalized) return;
      const now = Date.now();
      if (!force && now - lastPush < 2500) return; // throttle
      lastPush = now;
      const body = renderProgress();

      if (!commentId) {
        const created = await ghApi("POST", `/repos/${REPO}/issues/${ISSUE}/comments`, { body });
        if (created?.id) commentId = created.id;
      } else {
        await ghApi("PATCH", `/repos/${REPO}/issues/comments/${commentId}`, { body });
      }
    })
    .catch(() => {});
  return inflight;
}

async function finalComment(body) {
  if (!canComment) return;
  finalized = true;            // iske baad koi progress update nahi
  await inflight.catch(() => {}); // jo pending tha wo khatam ho jaye
  if (!commentId) {
    await ghApi("POST", `/repos/${REPO}/issues/${ISSUE}/comments`, { body });
  } else {
    await ghApi("PATCH", `/repos/${REPO}/issues/comments/${commentId}`, { body });
  }
}

const maxSteps = Number(process.env.MAX_STEPS) || 15;
const maxPhases = Number(process.env.MAX_PHASES) || 6;
const runtimeMin = Number(process.env.MAX_RUNTIME_MIN) || 300;
const deadline = Date.now() + runtimeMin * 60 * 1000;

console.log(`▶ Task: ${goal.slice(0, 200)}`);
const MODEL_LABEL = PROVIDER === "openai" ? (process.env.LLM_MODEL || "groq-default") : (process.env.GEMINI_MODEL || "gemini-2.5-flash");
console.log(`  provider: ${PROVIDER} · model: ${MODEL_LABEL} · steps/phase: ${maxSteps} · phases: ${maxPhases} · keys: ${API_KEYS.length}`);

await pushProgress(true);

// ── LIVE SCREEN → repo ke `live` branch me (Manus jaisa) ──────────────────
// Har frame ek "root commit" (parents: []) banata hai aur branch tip ko force-move
// karta hai — isliye history kabhi nahi badhti, repo nahi phoolta.
const GH_API = "https://api.github.com";
let frameCount = 0;
let lastFrameAt = 0;
let frameInflight = 0;
const MAX_INFLIGHT = 5;             // 3 frames ek saath upload (parallel)
let ghRemaining = 1000;            // GITHUB_TOKEN: 1000 req/hour
const MAX_FRAMES = Number(process.env.MAX_LIVE_FRAMES) || 400;
const BASE_EVERY = Number(process.env.LIVE_FRAME_MS) || 800;
// rate limit khatam ho raha ho to apne aap slow
const frameEvery = () => (ghRemaining < 250 ? 5000 : ghRemaining < 500 ? 2500 : BASE_EVERY);

async function ghJson(url, opts = {}) {
  const r = await fetch(url.startsWith("http") ? url : `${GH_API}${url}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "browser-agent",
      ...(opts.headers || {}),
    },
  });
  const rem = Number(r.headers.get("x-ratelimit-remaining"));
  if (Number.isFinite(rem) && rem > 0) ghRemaining = rem;
  const t = await r.text();
  let j = null;
  try { j = t ? JSON.parse(t) : null; } catch {}
  return { ok: r.ok, status: r.status, json: j };
}

async function pushLiveFrame(page) {
  if (!GH_TOKEN || !GH_REPO) return;
  if (frameInflight >= MAX_INFLIGHT || frameCount >= MAX_FRAMES) return;
  const now = Date.now();
  if (now - lastFrameAt < frameEvery()) return;
  lastFrameAt = now;
  frameInflight++;

  try {
    const [owner, repo] = GH_REPO.split("/");
    // chhota + halka frame = tez upload
    const buf = await page.screenshot({ type: "jpeg", quality: 22 });
    if (buf.length > 400_000) return;

    const blob = await ghJson(`/repos/${owner}/${repo}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: buf.toString("base64"), encoding: "base64" }),
    });
    if (!blob.ok) return;

    const tree = await ghJson(`/repos/${owner}/${repo}/git/trees`, {
      method: "POST",
      body: JSON.stringify({
        tree: [{ path: "outputs/live/latest.jpg", mode: "100644", type: "blob", sha: blob.json.sha }],
      }),
    });
    if (!tree.ok) return;

    const commit = await ghJson(`/repos/${owner}/${repo}/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message: `live frame ${frameCount + 1}`, tree: tree.json.sha, parents: [] }),
    });
    if (!commit.ok) return;

    const moved = await ghJson(`/repos/${owner}/${repo}/git/refs/heads/live`, {
      method: "PATCH",
      body: JSON.stringify({ sha: commit.json.sha, force: true }),
    });
    if (!moved.ok) {
      await ghJson(`/repos/${owner}/${repo}/git/refs`, {
        method: "POST",
        body: JSON.stringify({ ref: "refs/heads/live", sha: commit.json.sha }),
      });
    }
    frameCount++;
  } catch {}
  finally {
    frameInflight--;
  }
}

const browser = new BrowserManager({
  userDataDir: process.env.USER_DATA_DIR || "./data/browser-profile",
  headless: true,
});

// Manus jaisa: agent soch raha ho tab bhi screen update hoti rahe
const liveTimer = setInterval(() => {
  browser.page().then((pg) => pushLiveFrame(pg)).catch(() => {});
}, 900);

let body;
let ok = true;
try {
  const out = await runAgentTask({
    goal,
    browser,
    apiKey: API_KEYS[0],
    apiKeys: API_KEYS,
    maxSteps,
    maxPhases,
    deadline,
    onEvent: (e) => {
      if (e.type === "tool") {
        const a = e.args || {};
        const human = (HUMAN[e.name] || (() => e.name))(a);
        timeline.push({ type: "tool", name: e.name, human, detail: String(a.query || a.url || a.text || "").slice(0, 90) });
        console.log(`  → ${human}`);
        browser.page().then((pg) => pushLiveFrame(pg)).catch(() => {});
      } else if (e.type === "tool_error") {
        timeline.push({ type: "tool_error", name: e.name, human: HUMAN[e.name] ? HUMAN[e.name]({}) : e.name, detail: String(e.message).slice(0, 120) });
        console.log(`  ✗ ${e.name}: ${String(e.message).slice(0, 120)}`);
      } else if (e.type === "say") {
        timeline.push({ type: "say", detail: e.text.slice(0, 160) });
      } else if (e.type === "phase") {
        timeline.push({ type: "tool", name: "phase", human: e.text, detail: "" });
        console.log(`  ⟳ ${e.text}`);
      } else if (e.type === "verify") {
        timeline.push({ type: "tool", name: "verify", human: e.text, detail: "" });
        console.log(`  ✓ ${e.text}`);
      }
      pushProgress();
    },
  });
  body = out.result;
  if (out.hitLimit) ok = false;

} catch (err) {
  ok = false;
  const msg = String(err.message || err);

  if (/QUOTA|429|RESOURCE_EXHAUSTED/i.test(msg)) {
    body = [
      "## ⚠️ Gemini ka quota khatam hai",
      "",
      "**Ye aapki key ka limit hai, code ka bug nahi.** Free tier ki limit ho gayi hai.",
      "",
      "**Kya karein (koi ek):**",
      "1. **2-3 minute baad dobara chalayein** — per-minute rate limit bhi ho sakta hai",
      "2. **Nayi key, naye project me** — quota per-project hoti hai:",
      "   `aistudio.google.com/apikey` → Create API key → project me **New project** → key copy →",
      "   Repo → Settings → Secrets → `GEMINI_API_KEY` update",
      "3. Free tier ka daily quota reset hota hai **~12:30 PM IST** ke aas paas",
      "",
      `<sub>raw: ${msg.slice(0, 200)}</sub>`,
    ].join("\n");
  } else if (/thought_signature/i.test(msg)) {
    body = [
      "## ⚠️ Model signature error",
      "",
      "Task ke beech model badal gaya tha. Dobara chalane se theek ho jayega (ab model pin hota hai).",
      "",
      `<sub>raw: ${msg.slice(0, 200)}</sub>`,
    ].join("\n");
  } else {
    body = `## ❌ Agent fail ho gaya\n\n\`\`\`\n${msg.slice(0, 1500)}\n\`\`\``;
  }
} finally {
  clearInterval(liveTimer);
  // aakhri frame hamesha
  try {
    const pg = await browser.page();
    lastFrameAt = 0;
    await pushLiveFrame(pg);
  } catch {}
  await browser.close().catch(() => {});
}

const md = `# ${ok ? "✅" : "⚠️"} Task result\n\n**Goal:** ${goal}\n\n**Time:** ${elapsed()} · **Actions:** ${timeline.filter((t) => t.type === "tool").length}\n\n---\n\n${body}\n`;
fs.writeFileSync(path.resolve("./result.md"), md, "utf8");
fs.writeFileSync(path.join(OUTPUTS, `result-${Date.now()}.md`), md, "utf8");

if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  } catch {}
}

await finalComment(md);

console.log("\n" + "=".repeat(60));
console.log(body.slice(0, 4000));
console.log("=".repeat(60));

process.exit(ok ? 0 : 1);
