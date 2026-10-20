// Minimal Gemini REST client with function-calling support.
// No SDK on purpose: zero version drift, works on any Node >= 18.

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Model ko call-time pe padho — UI se badalne par restart ki zaroorat nahi.
export const currentModel = () => process.env.GEMINI_MODEL || "gemini-2.5-flash";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One turn against Gemini.
 * @returns {{ parts: Array<{text?:string, functionCall?:{name:string,args:object}}>, raw: object }}
 */
export async function generate({ apiKey, systemInstruction, contents, tools, temperature = 0.15 }) {
  if (!apiKey) throw new Error("GEMINI_API_KEY missing. Add it to .env");

  const url = `${BASE}/${currentModel()}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig: { temperature, maxOutputTokens: 8192 },
  };
  if (tools && tools.length) body.tools = [{ functionDeclarations: tools }];

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
        await sleep(1500 * (attempt + 1) ** 2);
        continue;
      }
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Gemini ${res.status}: ${txt.slice(0, 500)}`);
      }

      const json = await res.json();
      const cand = json.candidates?.[0];
      const parts = cand?.content?.parts || [];

      if (!parts.length) {
        const reason = cand?.finishReason || json.promptFeedback?.blockReason || "no content";
        if (reason === "MAX_TOKENS") return { parts: [{ text: "(response truncated)" }], raw: json };
        throw new Error(`Empty response from model (${reason})`);
      }
      return { parts, raw: json };
    } catch (err) {
      lastErr = err;
      if (attempt === 3) break;
      await sleep(1200 * (attempt + 1));
    }
  }
  throw lastErr;
}

export const modelName = currentModel;
