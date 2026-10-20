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
export async function generate({ apiKey, apiKeys, systemInstruction, contents, tools, temperature = 0.15, model }) {
  // Ek se zyada key ho to quota khatam hone pe agli key try hoti hai.
  const keys = (apiKeys && apiKeys.length ? apiKeys : [apiKey]).filter(Boolean);
  if (!keys.length) throw new Error("GEMINI_API_KEY missing. Add it to .env");

  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig: { temperature, maxOutputTokens: 8192 },
  };
  if (tools && tools.length) body.tools = [{ functionDeclarations: tools }];

  let lastErr;

  // `model` diya gaya to SIRF wahi use hoga. Ye zaroori hai: different models ki
  // functionCall signatures mix karne se Gemini 400 deta hai
  // ("Function call is missing a thought_signature").
  const chain = model ? [model] : modelChain();

  for (const model of chain) {
    for (const key of keys) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(
          `${BASE}/${model}:generateContent?key=${encodeURIComponent(key)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        );

        // Quota khatam / model gone → agla model, retry ka faayda nahi
        if (res.status === 429) {
          lastErr = new Error(`QUOTA: ${model}`);
          await sleep(1500 * (attempt + 1)); // rate-limit bhi ho sakta hai — chhota wait
          continue;
        }
        if (res.status === 404) {
          lastErr = new Error(`${model}: model available nahi`);
          break;
        }
        if (res.status >= 500) {
          lastErr = new Error(`${model}: service ${res.status}`);
          await sleep(800 * (attempt + 1));
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
    } // keys loop
    // is model se nahi hua — agla model try karo
    if (chain.length > 1) {
      console.warn(`[llm] ${model} fail (${String(lastErr?.message || "").slice(0, 70)}) → agla model`);
    }
  }

  throw lastErr || new Error("Gemini call failed");
}
