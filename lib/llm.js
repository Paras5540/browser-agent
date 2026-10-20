// Minimal Gemini REST client with function-calling + automatic model fallback.
// No SDK on purpose: zero version drift, works on any Node >= 18.

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Primary model + fallbacks (quota khatam hone pe agla model try hota hai). */
export function modelChain() {
  const primary = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const fallbacks = (process.env.FALLBACK_MODELS ??
    "gemini-2.5-flash-lite,gemini-flash-lite-latest,gemini-flash-latest")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([primary, ...fallbacks])];
}

export const currentModel = () => modelChain()[0];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One turn against Gemini. Tries each model in the chain on quota/not-found errors.
 * @returns {{ parts: Array<{text?:string, functionCall?:{name:string,args:object}}>, model: string, raw: object }}
 */
export async function generate({ apiKey, systemInstruction, contents, tools, temperature = 0.15 }) {
  if (!apiKey) throw new Error("GEMINI_API_KEY missing. Add it to .env");

  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig: { temperature, maxOutputTokens: 8192 },
  };
  if (tools && tools.length) body.tools = [{ functionDeclarations: tools }];

  let lastErr;

  for (const model of modelChain()) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(
          `${BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        );

        // Quota khatam / model gone → agla model, retry ka faayda nahi
        if (res.status === 429 || res.status === 404) {
          lastErr = new Error(`${model}: ${res.status} ${res.status === 429 ? "quota khatam" : "model available nahi"}`);
          break;
        }
        if (res.status >= 500) {
          lastErr = new Error(`${model}: ${res.status}`);
          await sleep(1200 * (attempt + 1));
          continue;
        }
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`${model} ${res.status}: ${txt.slice(0, 400)}`);
        }

        const json = await res.json();
        const cand = json.candidates?.[0];
        const parts = cand?.content?.parts || [];

        if (!parts.length) {
          const reason = cand?.finishReason || json.promptFeedback?.blockReason || "no content";
          if (reason === "MAX_TOKENS") {
            return { parts: [{ text: "(response truncated)" }], model, raw: json };
          }
          // Gemini kabhi kabhi 200 + khaali content deta hai (rate-limit / flakiness).
          // Fatal nahi — thoda ruk kar wahi model dobara try karo.
          lastErr = new Error(`Empty response (${reason})`);
          await sleep(2500 * (attempt + 1) ** 2);
          continue;
        }
        return { parts, model, raw: json };
      } catch (err) {
        lastErr = err;
        if (attempt === 2) break;
        await sleep(900 * (attempt + 1));
      }
    }
    // is model se nahi hua — agla try karo
    if (modelChain().length > 1) {
      console.warn(`[llm] ${model} fail (${lastErr?.message?.slice(0, 80)}) → agla model`);
    }
  }

  throw lastErr || new Error("Gemini call failed");
}
