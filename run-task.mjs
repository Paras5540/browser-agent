#!/usr/bin/env node
// Ek single task chala kar result file me likhta hai.
// GitHub Actions, cron, ya kahin se bhi chala sakte hain — server ki zaroorat nahi.
import fs from "node:fs";
import path from "node:path";
import { BrowserManager } from "./lib/browser.js";
import { runAgentTask } from "./lib/agent.js";

const OUTPUTS = path.resolve("./outputs");
fs.mkdirSync(OUTPUTS, { recursive: true });

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
  console.error("✗ GEMINI_API_KEY set nahi hai (Actions: Settings → Secrets → GEMINI_API_KEY).");
  process.exit(1);
}

const maxSteps = Number(process.env.MAX_STEPS) || 45;
const userDataDir = process.env.USER_DATA_DIR || "./data/browser-profile";

console.log(`▶ Task: ${goal.slice(0, 200)}`);
console.log(`  model: ${process.env.GEMINI_MODEL || "gemini-2.5-flash"} · max steps: ${maxSteps}`);

const browser = new BrowserManager({ userDataDir, headless: true });

let body;
let ok = true;
try {
  const out = await runAgentTask({
    goal,
    browser,
    apiKey: process.env.GEMINI_API_KEY,
    maxSteps,
    onEvent: (e) => {
      if (e.type === "tool") {
        const a = e.args || {};
        const d = a.query || a.url || a.text || a.selector || "";
        console.log(`  → ${e.name}${d ? `: ${String(d).slice(0, 80)}` : ""}`);
      } else if (e.type === "tool_error") {
        console.log(`  ✗ ${e.name}: ${String(e.message).slice(0, 120)}`);
      }
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

const stamp = new Date().toISOString();
const md = `# Task result\n\n**Goal:** ${goal}\n\n**Run:** ${stamp}\n\n---\n\n${body}\n`;
fs.writeFileSync(path.resolve("./result.md"), md, "utf8");
fs.writeFileSync(path.join(OUTPUTS, `result-${Date.now()}.md`), md, "utf8");

if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  } catch {}
}

console.log("\n" + "=".repeat(60));
console.log(body.slice(0, 4000));
console.log("=".repeat(60));

process.exit(ok ? 0 : 1);
