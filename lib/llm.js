// LLM client — do protocol support karta hai:
//   1. Gemini (native REST, function calling)
//   2. OpenAI-compatible (Groq, Cerebras, OpenRouter, GitHub Models, Ollama, LM Studio…)
//
// Provider .env / repo vars se chunta hai:
//   LLM_PROVIDER=gemini | openai
//   LLM_BASE_URL=https://api.groq.com/openai/v1
//   LLM_MODEL=llama-3.3-70b-versatile

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// ── provider registry: ek limit khatam → agla provider, task chalta rahe ──
const PROVIDER_DEFS = {
  groq: { base: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", model: "openai/gpt-oss-20b" },
  openrouter: { base: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", model: "minimax/minimax-m3.1-flash:free" },
  nvidia: { base: "https://integrate.api.nvidia.com/v1", keyEnv: "NVIDIA_API_KEY", model: "meta/llama-3.3-70b-instruct" },
};

// provider cooldown: 429 → thodi der baad wapas try, 401/403/404 → permanently band
const cooldown = new Map(); // label -> timestamp (Infinity = dead)
const DEAD = Infinity;
const RATE_COOLDOWN = 70_000; // TPM window reset

const isAvailable = (label) => {
  const t = cooldown.get(label);
  return !t || Date.now() >= t;
};
export const exhaustedProviders = () => [...cooldown.keys()];
export const resetExhausted = () => cooldown.clear();

function kindOf(base = "") {
  const b = base.toLowerCase();
  if (/groq\.com/.test(b)) return "groq";
  if (/openrouter\.ai/.test(b)) return "openrouter";
  if (/integrate\.api\.nvidia\.com/.test(b)) return "nvidia";
  if (/openrouter\.ai/.test(b)) return "openrouter";
  if (/dahl\.global/.test(b)) return "dahl";
  return "custom";
}

function geminiKeys() {
  return [process.env.GEMINI_API_KEY, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3, process.env.GEMINI_KEY_4]
    .map((k) => (k || "").trim())
    .filter(Boolean);
}

/** Kis order me try karna hai: primary, phir FALLBACK_PROVIDERS */
export function providerQueue() {
  const q = [];
  const isOpenAI = (process.env.LLM_PROVIDER || "gemini").toLowerCase() === "openai";

  if (isOpenAI) {
    const kind = kindOf(process.env.LLM_BASE_URL || "");
    const key = kind === "groq" ? process.env.GROQ_API_KEY : kind === "zen" ? process.env.ZEN_API_KEY
      : kind === "nvidia" ? process.env.NVIDIA_API_KEY : kind === "openrouter" ? process.env.OPENROUTER_API_KEY
      : kind === "dahl" ? process.env.DAHL_API_KEY
      : process.env.LLM_API_KEY;
    if (key) q.push({
      kind: "openai", label: kind, base: (process.env.LLM_BASE_URL || "").replace(/\/+$/, ""),
      key, model: process.env.LLM_MODEL || PROVIDER_DEFS[kind]?.model,
    });
  } else {
    const keys = geminiKeys();
    if (keys.length) q.push({ kind: "gemini", label: "gemini", models: modelChain(), keys });
  }

  // extra providers (comma separated): groq,zen,nvidia,openrouter
  const extras = (process.env.FALLBACK_PROVIDERS || "dahl,groq,openrouter,nvidia,gemini").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const ex of extras) {
    if (ex === "gemini") {
      if (!q.some((p) => p.kind === "gemini") && geminiKeys().length) {
        q.push({ kind: "gemini", label: "gemini", models: modelChain(), keys: geminiKeys() });
      }
      continue;
    }
    const def = PROVIDER_DEFS[ex];
    if (!def) continue;
    const key = process.env[def.keyEnv];
    if (!key) continue;
    if (q.some((p) => p.label === ex)) continue;
    q.push({ kind: "openai", label: ex, base: def.base, key, model: def.model });
  }
  return q;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const provider = () => (process.env.LLM_PROVIDER || "gemini").toLowerCase();
export const isOpenAI = () => provider() === "openai";

/** Gemini model chain (quota khatam hone pe agla). */
export function modelChain() {
  if (isOpenAI()) return [process.env.LLM_MODEL || "llama-3.3-70b-versatile"];
  const primary = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const fallbacks = (process.env.FALLBACK_MODELS ?? "gemini-2.5-flash-lite,gemini-flash-lite-latest")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([primary, ...fallbacks])];
}

export const currentModel = () => modelChain()[0];

/* ── internal contents (Gemini shape) → OpenAI messages ─────────────────── */
function toOpenAIMessages(contents, systemInstruction) {
  const msgs = [];
  if (systemInstruction) msgs.push({ role: "system", content: systemInstruction });

  const pending = []; // tool_call ids jinका response aana baaki hai
  let turnIdx = 0;

  for (const turn of contents) {
    const parts = turn.parts || [];
    turnIdx++;

    if (turn.role === "model") {
      const calls = parts.filter((p) => p.functionCall);
      const text = parts.filter((p) => typeof p.text === "string").map((p) => p.text).join("\n");
      const m = { role: "assistant", content: text || null };
      if (calls.length) {
        m.tool_calls = calls.map((c, i) => {
          const id = `call_${turnIdx}_${i}`;
          pending.push(id);
          return {
            id,
            type: "function",
            function: {
              name: c.functionCall.name,
              arguments: JSON.stringify(c.functionCall.args || {}),
            },
          };
        });
      }
      msgs.push(m);
      continue;
    }

    // user turn: functionResponses pehle, phir text
    for (const p of parts) {
      if (p.functionResponse) {
        const id = pending.shift() || `call_x_${turnIdx}`;
        msgs.push({
          role: "tool",
          tool_call_id: id,
          content: JSON.stringify(p.functionResponse.response ?? {}).slice(0, 12000),
        });
      }
    }
    const text = parts.filter((p) => typeof p.text === "string").map((p) => p.text).join("\n");
    if (text.trim()) msgs.push({ role: "user", content: text });
  }
  return msgs;
}

// Gemini schema (UPPERCASE types) → OpenAI/Groq JSON Schema (lowercase)
const TYPE_MAP = { OBJECT: "object", STRING: "string", INTEGER: "integer", NUMBER: "number", BOOLEAN: "boolean", ARRAY: "array" };

function normSchema(sch) {
  if (!sch || typeof sch !== "object") return sch;
  if (Array.isArray(sch)) return sch.map(normSchema);
  const out = {};
  for (const [k, v] of Object.entries(sch)) {
    if (k === "type" && typeof v === "string") {
      out.type = TYPE_MAP[v.toUpperCase()] || v.toLowerCase();
    } else if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, normSchema(pv)]));
    } else if (k === "items") {
      out.items = normSchema(v);
    } else if (v && typeof v === "object") {
      out[k] = normSchema(v);
    } else {
      out[k] = v;
    }
  }
  // khaali properties hone pe bhi valid rahe
  if (out.type === "object" && !out.properties) out.properties = {};
  return out;
}

function toOpenAITools(tools) {
  return (tools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: normSchema(t.parameters) || { type: "object", properties: {} },
    },
  }));
}

/* ── OpenAI-compatible call ──────────────────────────────────────────────── */
async function generateOpenAI({ apiKey, systemInstruction, contents, tools, temperature, model, baseUrl }) {
  const base = (baseUrl || process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
  const mdl = model || process.env.LLM_MODEL || "openai/gpt-oss-20b";

  const body = {
    model: mdl,
    messages: toOpenAIMessages(contents, systemInstruction),
    temperature: temperature ?? 0.15,
    max_tokens: Number(process.env.LLM_MAX_TOKENS) || 4096,
  };
  if (tools?.length) {
    body.tools = toOpenAITools(tools);
    body.tool_choice = "auto";
  }

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429) throw new Error(`QUOTA: ${mdl}`);
  if (res.status === 404) throw new Error(`${mdl}: model available nahi`);
  if (res.status >= 500) throw new Error(`${mdl}: service ${res.status}`);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${mdl} ${res.status}: ${txt.slice(0, 300)}`);
  }

  const json = await res.json();
  const msg = json.choices?.[0]?.message;
  if (!msg) throw new Error("Empty response");

  const parts = [];
  const cleanText = (t) =>
    String(t || "")
      .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
      .replace(/^\s*<think(?:ing)?>[\s\S]*$/i, "")
      .trim();
  const visible = cleanText(msg.content);
  if (visible) parts.push({ text: visible });
  for (const tc of msg.tool_calls || []) {
    let args = {};
    try {
      args = JSON.parse(tc.function?.arguments || "{}");
    } catch {
      args = {};
    }
    parts.push({ functionCall: { name: tc.function?.name, args } });
  }
  if (!parts.length) throw new Error("Empty response (no content, no tool calls)");

  return { parts, model: mdl, raw: json };
}

/* ── Gemini call (existing) ──────────────────────────────────────────────── */
async function generateGemini({ apiKey, apiKeys, systemInstruction, contents, tools, temperature, model }) {
  const keys = (apiKeys && apiKeys.length ? apiKeys : [apiKey]).filter(Boolean);
  if (!keys.length) throw new Error("GEMINI_API_KEY missing. Add it to .env");

  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig: { temperature: temperature ?? 0.15, maxOutputTokens: 8192 },
  };
  if (tools?.length) body.tools = [{ functionDeclarations: tools }];

  let lastErr;
  const chain = model ? [model] : modelChain();

  for (const mdl of chain) {
    for (const key of keys) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(`${GEMINI_BASE}/${mdl}:generateContent?key=${encodeURIComponent(key)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });

          if (res.status === 429) {
            lastErr = new Error(`QUOTA: ${mdl}`);
            await sleep(1500 * (attempt + 1));
            continue;
          }
          if (res.status === 404) {
            lastErr = new Error(`${mdl}: model available nahi`);
            break;
          }
          if (res.status >= 500) {
            lastErr = new Error(`${mdl}: service ${res.status}`);
            await sleep(800 * (attempt + 1));
            continue;
          }
          if (!res.ok) {
            const txt = await res.text();
            throw new Error(`${mdl} ${res.status}: ${txt.slice(0, 400)}`);
          }

          const json = await res.json();
          const cand = json.candidates?.[0];
          const parts = cand?.content?.parts || [];

          if (!parts.length) {
            const reason = cand?.finishReason || json.promptFeedback?.blockReason || "no content";
            if (reason === "MAX_TOKENS") return { parts: [{ text: "(response truncated)" }], model: mdl, raw: json };
            lastErr = new Error(`Empty response (${reason})`);
            await sleep(2500 * (attempt + 1) ** 2);
            continue;
          }
          return { parts, model: mdl, raw: json };
        } catch (err) {
          lastErr = err;
          if (attempt === 2) break;
          await sleep(900 * (attempt + 1));
        }
      }
    }
    if (chain.length > 1) {
      console.warn(`[llm] ${mdl} fail (${String(lastErr?.message || "").slice(0, 70)}) → agla model`);
    }
  }
  throw lastErr || new Error("Gemini call failed");
}

/* ── public entry ────────────────────────────────────────────────────────── */
export async function generate(opts) {
  const MAX_CYCLES = 10; // itni baar "sab limit pe hain" ka intezaar karega
  let lastErr = null;

  for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
  const all = providerQueue();
  const queue = all.filter((p) => isAvailable(p.label));

  // sab cooldown pe hain → sabse jaldi wale ka intezaar
  if (!queue.length) {
    const times = all.map((p) => cooldown.get(p.label) ?? 0).filter((t) => Number.isFinite(t));
    const waitMs = times.length ? Math.max(4000, Math.min(Math.min(...times) - Date.now(), 90_000)) : 15_000;
    opts.onEvent?.({ type: "phase", text: `Saare models limit pe — ${Math.round(waitMs / 1000)}s baad khud retry` });
    console.warn(`[llm] sab models cooldown pe — ${Math.round(waitMs / 1000)}s wait`);
    await sleep(waitMs);
    continue;
  }

  for (const prov of queue) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (prov.kind === "gemini") {
          const r = await generateGemini({
            ...opts,
            apiKeys: prov.keys,
            model: opts.model && prov.models.includes(opts.model) ? opts.model : undefined,
          });
          if (!exhausted.has("gemini")) return { ...r, provider: "gemini" };
          break;
        }
        const r = await generateOpenAI({
          ...opts,
          apiKey: prov.key,
          baseUrl: prov.base,
          model: opts.model ? undefined : prov.model,
        });
        return { ...r, provider: prov.label };
      } catch (err) {
        lastErr = err;
        const m = String(err.message || "");
        if (/QUOTA|429/i.test(m)) {
          cooldown.set(prov.label, Date.now() + RATE_COOLDOWN);
          opts.onEvent?.({ type: "phase", text: `${prov.label} limit — 70s baad wapas, ab agla model` });
          console.warn(`[llm] ${prov.label} 429 → cooldown 70s`);
          break;
        }
        if (/402|INSUFFICIENT|tokens exhausted|available tokens/i.test(m)) {
          cooldown.set(prov.label, DEAD);
          opts.onEvent?.({ type: "phase", text: `${prov.label} ke tokens khatam (402) — agla model` });
          break;
        }
        if (/403|401|404|model available nahi/i.test(m)) {
          cooldown.set(prov.label, DEAD);
          console.warn(`[llm] ${prov.label} dead → next provider`);
          break;
        }
        if (/missing a thought_signature/i.test(m)) {
          cooldown.set(prov.label, Date.now() + 5000);
          break;
        }
        if (attempt === 1) break;
        await sleep(1200);
      }
    }
  }

  } // cycle loop

  if (lastErr) throw lastErr;
  throw new Error("Koi bhi provider available nahi (sab limits khatam) — keys check karein");
}

async function generate_single(opts) {
  if (isOpenAI()) {
    const key = opts.apiKey || opts.apiKeys?.[0] || process.env.LLM_API_KEY;
    if (!key) throw new Error("LLM_API_KEY missing (OpenAI-compatible provider)");
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await generateOpenAI({ ...opts, apiKey: key });
      } catch (err) {
        lastErr = err;
        if (/QUOTA|429/.test(String(err.message))) {
          // rate limit / TPM window — minute roll hone ka intezaar
          await sleep(15000 * (attempt + 1));
          continue;
        }
        if (attempt === 2) break;
        await sleep(800 * (attempt + 1));
      }
    }
    throw lastErr;
  }
  return generateGemini(opts);
}
