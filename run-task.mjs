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
const GH_API = "https://api.github.com";
let ghRemaining = 1000;   // GitHub API quota (frames ke liye)
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

/** Same issue ki poori memory: root goal + purani instructions + last result */
async function buildGoalFromIssue() {
  try {
    const [owner, repo] = GH_REPO.split("/");
    const iss = await ghJson(`/repos/${owner}/${repo}/issues/${ISSUE}`);
    const cs = await ghJson(`/repos/${owner}/${repo}/issues/${ISSUE}/comments?per_page=100`);
    const base = (iss.json?.body || iss.json?.title || "").trim();
    const comments = (cs.json || []).map((c) => c.body || "");

    const instructions = [];
    let lastResult = "";
    for (const c of comments) {
      const m = c.match(/<!--\s*agent-continue\s*-->[\s\S]*?NEW INSTRUCTION:\s*([\s\S]*)/i);
      if (m) instructions.push(m[1].replace(/<!--[\s\S]*?-->/g, "").trim().slice(0, 800));
      else if (/#\s*(✅|⚠️)\s*Task result/i.test(c)) lastResult = c;
    }

    const parts = [`ROOT GOAL:\n${base}`];
    if (instructions.length > 1) {
      parts.push(`PREVIOUS INSTRUCTIONS:\n${instructions.slice(0, -1).map((x, i) => `${i + 1}. ${x}`).join("\n")}`);
    }
    if (lastResult) parts.push(`PREVIOUS RESULT:\n${lastResult.slice(0, 3000)}`);
    if (instructions.length) parts.push(`CURRENT INSTRUCTION:\n${instructions[instructions.length - 1]}`);
    parts.push(
      "NOTE: ye wahi task hai jo pehle chal chuka hai. Jo ho chuka hai DOBARA MAT KARO. " +
        "Pichhle result ko improve/complete karo aur ROOT GOAL ke hisaab se hi jawab do."
    );
    return parts.join("\n\n");
  } catch (e) {
    console.error("goal-build failed:", e && e.message ? e.message : e);
    return "";
  }
}

const EVENT = String(process.env.EVENT_NAME || "");
const issueDriven = (EVENT === "issues" || EVENT === "issue_comment") && ISSUE && GH_REPO;

// Issue se chalne wale run me goal HAMESHA issue thread se banta hai
// (root goal + purani instructions + last result) — scheduled text kabhi nahi.
let goal = issueDriven ? "" : resolveGoal();
if (issueDriven) {
  goal = await buildGoalFromIssue();
  if (!goal) goal = resolveGoal();
}
if (!goal) {
  console.error("✗ Koi task nahi mila. TASK_GOAL env, CLI arg, ya tasks/scheduled.txt dein.");
  process.exit(1);
}
const PROVIDER = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
const LLM_BASE = (process.env.LLM_BASE_URL || "").toLowerCase();

// base URL se sahi secret chuno
const KEY_BY_HOST = [
  [/dahl\.global/, "DAHL_API_KEY"],
  [/openrouter\.ai/, "OPENROUTER_API_KEY"],
  [/opencode\.ai/, "ZEN_API_KEY"],
  [/groq\.com/, "GROQ_API_KEY"],
  [/nvidia/, "NVIDIA_API_KEY"],
];
const matchedEnv = (KEY_BY_HOST.find(([re]) => re.test(LLM_BASE)) || [])[1];
const LLM_KEY = (
  matchedEnv ? process.env[matchedEnv] : process.env.LLM_API_KEY
) || process.env.LLM_API_KEY || process.env.DAHL_API_KEY || process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY || process.env.NVIDIA_API_KEY || "";
const LLM_KEY_TRIMMED = LLM_KEY.trim();
const GEMINI_KEYS = [process.env.GEMINI_API_KEY, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3, process.env.GEMINI_KEY_4]
  .map((k) => (k || "").trim())
  .filter(Boolean);

const API_KEYS = PROVIDER === "openai" ? (LLM_KEY_TRIMMED ? [LLM_KEY_TRIMMED] : []) : GEMINI_KEYS;
const API_KEY_MAIN = API_KEYS[0];

if (!API_KEYS.length) {
  console.error(
    PROVIDER === "openai"
      ? `✗ LLM_API_KEY set nahi hai (${matchedEnv || "LLM_API_KEY"}) — Repo → Settings → Secrets → ${matchedEnv || "LLM_API_KEY"}`
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
const journal = [];
let boardCache = "";
const startedAt = Date.now();

const REPORTS = path.resolve("./outputs/reports");
fs.mkdirSync(REPORTS, { recursive: true });

function log(text) {
  journal.push(`${new Date().toISOString().slice(11, 19)}  ${text}`);
  // har phase pe report file save — run beech me mare to bhi kaam bacha rahe
  try {
    fs.writeFileSync(path.join(REPORTS, "latest.md"), renderReport());
  } catch {}
}

function renderReport(meta = {}) {
  const head = [
    "# Agent work report",
    "",
    `**Goal:** ${goal}`,
    `**Started:** ${new Date(startedAt).toISOString()}`,
    meta.phases ? `**Phases:** ${meta.phases}` : "",
    meta.score !== undefined ? `**Accuracy:** ${meta.score}%` : "",
    meta.status ? `**Status:** ${meta.status}` : "",
    "",
    "## Work log",
    "",
  ].filter(Boolean);
  return head.join("\n") + "\n" + journal.map((l) => `- ${l}`).join("\n") + "\n";
}

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
    boardCache ? `\n**Board (yaad rakha):**\n${boardCache}` : "",
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
let frameCount = 0;
let lastFrameAt = 0;
let frameInflight = 0;
const MAX_INFLIGHT = 5;             // 3 frames ek saath upload (parallel)
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
let out = null;
try {
  out = await runAgentTask({
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
        try { boardCache = browser.boardSnapshot(12); } catch {}
        console.log(`  → ${human}`);
        log(`${human}`);
        browser.page().then((pg) => pushLiveFrame(pg)).catch(() => {});
      } else if (e.type === "tool_error") {
        timeline.push({ type: "tool_error", name: e.name, human: HUMAN[e.name] ? HUMAN[e.name]({}) : e.name, detail: String(e.message).slice(0, 120) });
        console.log(`  ✗ ${e.name}: ${String(e.message).slice(0, 120)}`);
        log(`✗ ${e.name} fail — ${String(e.message).slice(0, 80)}`);
      } else if (e.type === "say") {
        timeline.push({ type: "say", detail: e.text.slice(0, 160) });
      } else if (e.type === "phase") {
        timeline.push({ type: "tool", name: "phase", human: e.text, detail: "" });
        console.log(`  ⟳ ${e.text}`);
        log(`--- ${e.text}`);
      } else if (e.type === "verify") {
        timeline.push({ type: "tool", name: "verify", human: e.text, detail: "" });
        console.log(`  ✓ ${e.text}`);
        log(`✔ ${e.text}`);
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
    const provLabel = PROVIDER === "openai" ? (/opencode\.ai/i.test(process.env.LLM_BASE_URL || "") ? "OpenCode Zen" : "Groq") : "Gemini";
    body = [
      `## ⚠️ ${provLabel} ka rate limit (quota)`,
      "",
      `**Model:** \`${MODEL_LABEL}\` — provider ne 429 diya (per-minute token limit).`,
      "**Ye aapki key ka limit hai, code ka bug nahi.**",
      "",
      "**Kya karein (koi ek):**",
      "1. **2-3 minute baad dobara chalayein** — per-minute limit reset ho jati hai",
      "2. **Model badal dein** — chat ke upar model button se `llama-3.1-8b-instant` (zyada TPM) chunein",
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

const score = out?.score ?? null;
const meta = { phases: out?.phases, score, status: ok ? "complete" : "incomplete" };
const report = renderReport(meta);
try {
  fs.writeFileSync(path.join(REPORTS, `report-${Date.now()}.md`), report);
  fs.writeFileSync(path.join(REPORTS, "latest.md"), report);
} catch {}

// board ko file me save — agla run/follow-up bhi padh sakta hai
try {
  const stDir = path.resolve("./outputs/state");
  fs.mkdirSync(stDir, { recursive: true });
  const boardObj = Object.fromEntries(browser.board || []);
  fs.writeFileSync(path.join(stDir, "latest.json"), JSON.stringify(boardObj, null, 2));
  fs.writeFileSync(path.join(stDir, `board-${Date.now()}.json`), JSON.stringify(boardObj, null, 2));
} catch {}

const md =
  `# ${ok ? "✅" : "⚠️"} Task result${score !== null ? ` — ${score}%` : ""}\n\n` +
  `**Goal:** ${goal}\n\n` +
  `**Time:** ${elapsed()} · **Steps:** ${timeline.filter((t) => t.type === "tool").length}` +
  `${out?.phases ? ` · **Phases:** ${out.phases}` : ""}${score !== null ? ` · **Accuracy:** ${score}%` : ""}\n\n` +
  `---\n\n${body}\n\n` +
  (boardCache ? `<details><summary>Data board (saved fields)</summary>\n\n${boardCache}\n\n</details>\n\n` : "") +
  `<details><summary>Work report (${journal.length} entries)</summary>\n\n` +
  journal.map((l) => `- ${l}`).join("\n") +
  `\n\n</details>\n`;

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
