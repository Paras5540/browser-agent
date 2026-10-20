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
if (!process.env.GEMINI_API_KEY) {
  console.error("✗ GEMINI_API_KEY set nahi hai (Settings → Secrets → GEMINI_API_KEY).");
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

function renderProgress() {
  const lines = timeline.slice(-22).map((e) => {
    if (e.type === "tool") return `- ✓ \`${e.name}\`${e.detail ? ` — ${e.detail}` : ""}`;
    if (e.type === "tool_error") return `- ✗ \`${e.name}\` — ${e.detail}`;
    return `- 💬 ${e.detail}`;
  });
  return [
    "### 🔄 Agent chal raha hai…",
    "",
    `**Task:** ${goal.split("\n")[0].slice(0, 160)}`,
    `**Elapsed:** ${elapsed()} · **Actions:** ${timeline.filter((t) => t.type === "tool").length}`,
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

console.log(`▶ Task: ${goal.slice(0, 200)}`);
console.log(`  model: ${process.env.GEMINI_MODEL || "gemini-2.5-flash"} · max steps: ${process.env.MAX_STEPS || 45}`);

await pushProgress(true);

const browser = new BrowserManager({
  userDataDir: process.env.USER_DATA_DIR || "./data/browser-profile",
  headless: true,
});

let body;
let ok = true;
try {
  const out = await runAgentTask({
    goal,
    browser,
    apiKey: process.env.GEMINI_API_KEY,
    maxSteps: Number(process.env.MAX_STEPS) || 45,
    onEvent: (e) => {
      if (e.type === "tool") {
        const a = e.args || {};
        const d = a.query || a.url || a.text || a.selector || "";
        timeline.push({ type: "tool", name: e.name, detail: String(d).slice(0, 90) });
        console.log(`  → ${e.name}${d ? `: ${String(d).slice(0, 80)}` : ""}`);
      } else if (e.type === "tool_error") {
        timeline.push({ type: "tool_error", name: e.name, detail: String(e.message).slice(0, 120) });
        console.log(`  ✗ ${e.name}: ${String(e.message).slice(0, 120)}`);
      } else if (e.type === "say") {
        timeline.push({ type: "say", detail: e.text.slice(0, 160) });
      }
      pushProgress();
    },
  });
  body = out.result;
  if (out.hitLimit) ok = false;
} catch (err) {
  ok = false;
  body = `❌ Agent fail ho gaya:\n\n\`\`\`\n${String(err.message || err).slice(0, 2000)}\n\`\`\``;
} finally {
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
