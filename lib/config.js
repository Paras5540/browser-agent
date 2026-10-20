// Runtime settings: .env ko live edit karta hai taaki UI se key add ho sake
// bina server restart kiye.
import fs from "node:fs";
import path from "node:path";

const ENV_PATH = path.resolve("./.env");
const DEFAULT_MODEL = "gemini-2.5-flash";

export const MODEL_CHOICES = [
  { id: "gemini-2.5-flash", label: "gemini-2.5-flash — balanced (recommended)" },
  { id: "gemini-2.5-flash-lite", label: "gemini-2.5-flash-lite — fastest, cheapest" },
  { id: "gemini-2.5-pro", label: "gemini-2.5-pro — smarter, slower" },
];

function readLines() {
  try {
    return fs.readFileSync(ENV_PATH, "utf8").split("\n");
  } catch {
    return [];
  }
}

/** .env me keys update karta hai, baaki lines/comments waise hi rehte hain. */
function setEnvFileVars(pairs) {
  const lines = readLines();
  const pending = new Map(Object.entries(pairs));
  const out = [];

  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && pending.has(m[1])) {
      out.push(`${m[1]}=${pending.get(m[1])}`);
      pending.delete(m[1]);
    } else {
      out.push(line);
    }
  }
  for (const [k, v] of pending) out.push(`${k}=${v}`);

  fs.writeFileSync(ENV_PATH, out.join("\n"), { mode: 0o600 });
  try {
    fs.chmodSync(ENV_PATH, 0o600);
  } catch {}
}

function validKey(k) {
  return Boolean(k) && k !== "YOUR_KEY_HERE" && k.length > 12;
}

export function publicSettings() {
  const key = process.env.GEMINI_API_KEY || "";
  return {
    hasKey: validKey(key),
    keyMask: validKey(key) ? `${key.slice(0, 4)}…${key.slice(-4)}` : "",
    model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
    headless: String(process.env.HEADLESS ?? "true") !== "false",
    maxSteps: Number(process.env.MAX_STEPS) || 45,
    passwordSet: Boolean(process.env.DASHBOARD_PASSWORD),
    models: MODEL_CHOICES,
  };
}

/**
 * UI se aaya patch save karta hai. Sirf jo field diye gaye hain wo badalte hain.
 * @returns {{ changed: string[] }}
 */
export function saveSettings(patch = {}) {
  const pairs = {};
  const changed = [];

  if (typeof patch.apiKey === "string" && patch.apiKey.trim()) {
    const k = patch.apiKey.trim();
    pairs.GEMINI_API_KEY = k;
    process.env.GEMINI_API_KEY = k; // live, KOI restart nahi
    changed.push("apiKey");
  }

  if (patch.model) {
    const m = String(patch.model).trim();
    if (!MODEL_CHOICES.some((c) => c.id === m)) throw new Error(`Unknown model: ${m}`);
    pairs.GEMINI_MODEL = m;
    process.env.GEMINI_MODEL = m;
    changed.push("model");
  }

  if (typeof patch.headless === "boolean") {
    pairs.HEADLESS = patch.headless ? "true" : "false";
    process.env.HEADLESS = pairs.HEADLESS;
    changed.push("headless");
  }

  if (patch.maxSteps !== undefined) {
    const n = Math.max(5, Math.min(200, Number(patch.maxSteps) || 45));
    pairs.MAX_STEPS = String(n);
    process.env.MAX_STEPS = pairs.MAX_STEPS;
    changed.push("maxSteps");
  }

  if (typeof patch.dashboardPassword === "string" && patch.dashboardPassword.trim()) {
    const p = patch.dashboardPassword.trim();
    pairs.DASHBOARD_PASSWORD = p;
    process.env.DASHBOARD_PASSWORD = p;
    changed.push("dashboardPassword");
  }

  if (changed.length) setEnvFileVars(pairs);
  return { changed };
}

/**
 * Key ko sach me valid karta hai — models list endpoint pe call (0 tokens kharch).
 * @returns {Promise<{ ok: boolean, message: string, models?: string[] }>}
 */
export async function testApiKey(key) {
  const k = (key || process.env.GEMINI_API_KEY || "").trim();
  if (!validKey(k)) return { ok: false, message: "Key khaali hai ya placeholder hai (YOUR_KEY_HERE)" };

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(k)}&pageSize=100`,
      { headers: { "Content-Type": "application/json" } }
    );
    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      const reason = json?.error?.status || `HTTP ${res.status}`;
      const msg =
        reason === "INVALID_ARGUMENT" || json?.error?.message?.includes("API key not valid")
          ? "Key valid nahi hai — aistudio.google.com/apikey se nayi banayein"
          : json?.error?.message || reason;
      return { ok: false, message: msg };
    }

    const names = (json.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => String(m.name).replace("models/", ""));

    const wanted = process.env.GEMINI_MODEL || DEFAULT_MODEL;
    if (names.length && !names.includes(wanted)) {
      const near = names.filter((n) => n.startsWith("gemini")).slice(0, 6);
      return {
        ok: true,
        message: `Key valid hai, par "${wanted}" is key ke liye available nahi. Ye available hain: ${near.join(", ")}`,
        models: near,
      };
    }
    return { ok: true, message: `Key valid hai ✓ — ${wanted} ready hai`, models: names.slice(0, 10) };
  } catch (err) {
    return { ok: false, message: `Network error: ${err.message}` };
  }
}
