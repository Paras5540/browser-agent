// Workflow replay: successful runs ke actions save karke dobara bina LLM chalana.
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve("./skills");
const SAFE = new Set(["navigate", "click", "type", "select", "check", "fill_form", "extract", "extract_links", "extract_table", "extract_json", "read_page", "capture", "screenshot", "save_results", "save_field", "scroll_to", "wait"]);

const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

export function saveReplay(url, actions) {
  const host = hostOf(url);
  if (!host) return false;
  const clean = (actions || []).filter((a) => a && SAFE.has(a.tool));
  if (clean.length < 2) return false;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, `${host.replace(/[^a-z0-9.-]/g, "_")}.replay.json`);
    fs.writeFileSync(file, JSON.stringify({ url, host, savedAt: new Date().toISOString(), actions: clean.slice(-40) }, null, 2));
    return true;
  } catch {
    return false;
  }
}

export function loadReplay(url) {
  const host = hostOf(url);
  if (!host) return null;
  try {
    const file = path.join(DIR, `${host.replace(/[^a-z0-9.-]/g, "_")}.replay.json`);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Deterministic replay. Koi bhi step fail → {ok:false, failedAt} (agent fallback karega). */
export async function runReplay(browser, actions) {
  const done = [];
  for (let i = 0; i < actions.length; i++) {
    const step = actions[i];
    try {
      const out = await browser.runTool(step.tool, step.args || {});
      done.push({ ...step, ok: true, text: String(out.text || "").slice(0, 500) });
    } catch (e) {
      return { ok: false, failedAt: i, step, error: e.message, done };
    }
  }
  return { ok: true, done };
}

export function listReplays() {
  try {
    return fs.readdirSync(DIR).filter((f) => f.endsWith(".replay.json"));
  } catch {
    return [];
  }
}
