#!/usr/bin/env node
// CLI: node replay.mjs <url>          → saved replay chalao
//      node replay.mjs --list          → saved replays dikhao
import { BrowserManager } from "./lib/browser.js";
import { loadReplay, runReplay, listReplays } from "./lib/replay.js";

const arg = process.argv[2];
if (!arg || arg === "--list") {
  const l = listReplays();
  console.log(l.length ? l.join("\n") : "(koi replay saved nahi)");
  process.exit(0);
}
const rec = loadReplay(arg);
if (!rec) {
  console.log(`Is site ka replay nahi mila: ${arg}`);
  process.exit(1);
}
console.log(`Replay: ${rec.actions.length} steps · saved ${rec.savedAt}`);
const b = new BrowserManager({ userDataDir: "./data/browser-profile", headless: process.env.HEADLESS !== "false" });
try {
  const res = await runReplay(b, rec.actions);
  if (res.ok) {
    console.log(`REPLAY OK — ${res.done.length} steps, LLM calls: 0`);
    console.log((res.done.at(-1)?.text || "").slice(0, 400));
  } else {
    console.log(`REPLAY FAILED at step ${res.failedAt} (${res.step.tool}): ${res.error}`);
    console.log("→ Agent mode me chalayein (LLM use hoga)");
    process.exit(1);
  }
} finally {
  await b.close();
}
