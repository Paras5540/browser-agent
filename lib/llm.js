// LLM client — do protocol support karta hai:
//   1. Gemini (native REST, function calling)
//   2. OpenAI-compatible (Groq, Cerebras, OpenRouter, GitHub Models, Ollama, LM Studio…)
//
// Provider .env / repo vars se chunta hai:
//   LLM_PROVIDER=gemini | openai
//   LLM_BASE_URL=https://api.groq.com/openai/v1
//   LLM_MODEL=llama-3.3-70b-versatile

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

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
async function generateOpenAI({ apiKey, systemInstruction, contents, tools, temperature, model }) {
  const base = (process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
  const mdl = model || process.env.LLM_MODEL || "llama-3.3-70b-versatile";

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
  if (msg.content && String(msg.content).trim()) parts.push({ text: String(msg.content).trim() });
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
