// Cross-run memory + checkpoints. Files repo me commit hote hain, isliye
// agla run (ya restart ke baad) pichhla kaam padh kar continue kar sakta hai.
import fs from "node:fs";
import path from "node:path";

const MEM_DIR = path.resolve("./outputs/memory");

function ensure() {
  fs.mkdirSync(MEM_DIR, { recursive: true });
}

/* ── checkpoint: ek task ka live state ─────────────────────────────────── */
export function saveCheckpoint(issue, state) {
  if (!issue) return;
  ensure();
  const file = path.join(MEM_DIR, `task-${issue}.json`);
  const prev = loadCheckpoint(issue) || {};
  const next = {
    ...prev,
    ...state,
    issue: String(issue),
    updatedAt: new Date().toISOString(),
    runs: (prev.runs || 0) + (state.final ? 0 : 1),
  };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
}

export function loadCheckpoint(issue) {
  if (!issue) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(MEM_DIR, `task-${issue}.json`), "utf8"));
  } catch {
    return null;
  }
}

export function clearCheckpoint(issue) {
  try {
    fs.unlinkSync(path.join(MEM_DIR, `task-${issue}.json`));
  } catch {}
}

/* ── long-term findings: har task ke results yahan jama hote hain ──────── */
const FINDINGS = () => path.join(MEM_DIR, "findings.md");

export function appendFindings(entry) {
  ensure();
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const block = `\n## ${stamp} — issue #${entry.issue || "?"}\n${entry.summary || ""}\n`;
  try {
    fs.appendFileSync(FINDINGS(), block);
    // file ko bounded rakho
    const txt = fs.readFileSync(FINDINGS(), "utf8");
    if (txt.length > 400_000) fs.writeFileSync(FINDINGS(), txt.slice(-300_000));
  } catch {}
}

/** Purani findings ka relevant hissa (keyword match) — naye task ke liye */
export function recallFindings(goal, maxChars = 3000) {
  let txt = "";
  try {
    txt = fs.readFileSync(FINDINGS(), "utf8");
  } catch {
    return "";
  }
  const words = String(goal || "")
    .toLowerCase()
    .split(/[^a-z0-9\u0900-\u097F]+/)
    .filter((w) => w.length > 3)
    .slice(0, 12);
  if (!words.length) return txt.slice(-maxChars);

  const blocks = txt.split(/\n## /).filter(Boolean);
  const scored = blocks
    .map((b) => {
      const low = b.toLowerCase();
      return { b, score: words.reduce((n, w) => n + (low.includes(w) ? 1 : 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  if (!scored.length) return "";
  return scored.map((x) => `## ${x.b}`).join("\n").slice(0, maxChars);
}
