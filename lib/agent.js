// The reasoning loop: goal -> Gemini -> browser tools -> repeat -> answer.
import { generate } from "./llm.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * History trim — quota bachata hai.
 * Sirf poore (model, user) jode hataata hai, isliye functionCall/functionResponse
 * ki jodi kabhi nahi tootti (wahi cheez pehle 400 error laayi thi).
 */
export function trimHistory(contents, maxTurns = 12) {
  const excess = contents.length - 1 - maxTurns * 2;
  if (excess <= 0) return;
  const d = excess % 2 === 0 ? excess : excess + 1;   // even rakho
  if (1 + d >= contents.length - 1) return;
  contents.splice(1, d);
  const p0 = contents[0]?.parts;
  if (Array.isArray(p0) && !p0.some((x) => typeof x.text === "string" && x.text.includes("(purane steps"))) {
    p0.push({ text: "\n\n(purane steps trim ho gaye — quota bachane ke liye. Apne notes se continue karein.)" });
  }
}
import { TOOL_DECLARATIONS } from "./browser.js";

export const SYSTEM = `You are an autonomous web-browsing agent running headless Chrome through Playwright.
You complete the user's goal end-to-end by calling tools. You do not ask clarifying questions —
if something is ambiguous, pick the most reasonable interpretation and proceed.

HOW TO WORK
1. Plan silently. Then act, one tool call at a time.
2. For research, start with search() and open the promising links. Never invent a URL from memory if
   search can give you the real one.
3. Before clicking, call elements() to see the page's controls and click by index. Fall back to
   text= then selector= only if index fails.
4. Pages change: after every click/type you already receive a fresh snapshot. Read it before the next move.
5. Collecting lists: use extract() with a CSS selector — it is far cheaper than read_page().
6. On anti-bot walls, cookie banners or captchas: try clicking "Accept"/"Allow all"/"I agree",
   waiting, scrolling, or opening a different source. If a site is truly blocked, move to another site
   and note it in your final answer. Never spend more than 4 attempts on one blocked site.
7. LONG TASKS: after every meaningful chunk of data, call note() with what you found so far, and
   call read_notes() if you lose track. Never restart work you already did.
8. Before finishing a task that produced data, call save_results() with a clean CSV or Markdown table.
9. Finish with finish(summary=...). The summary must be a short, factual report of what you did,
   what you found, and anything that failed. Write it in the user's language (often Hinglish/English).

HARD RULES
- Never claim you did something you did not actually do with a tool call.
- If you could not obtain a fact, say so plainly instead of guessing.
- Do not log in, sign up, pay, or send messages unless the goal explicitly asks for it.
- Stay efficient: a simple research task should take under 15 tool calls.`;

export async function runAgentTask({ goal, browser, apiKey, apiKeys, maxSteps = 45, onEvent = () => {} }) {
  const contents = [{ role: "user", parts: [{ text: `GOAL:\n${goal}` }] }];
  const steps = [];
  let finalText = null;
  const t0 = Date.now();

  let emptyRounds = 0;
  let pinnedModel = null; // ek task = ek model (signature mismatch se bachne ke liye)

  for (let step = 1; step <= maxSteps; step++) {
    onEvent({ type: "thinking", step });
    trimHistory(contents);

    let parts;
    let usedModel;
    try {
      const res = await generate({
        apiKey,
        apiKeys,
        systemInstruction: SYSTEM,
        contents,
        tools: TOOL_DECLARATIONS,
        model: pinnedModel,
      });
      parts = res.parts;
      usedModel = res.model;
      emptyRounds = 0;
      if (!pinnedModel) {
        pinnedModel = usedModel;
        onEvent({ type: "model", text: `model: ${pinnedModel}` });
      }
    } catch (err) {
      const msg = String(err.message || err);
      // quota / khaali jawab — turant fail na karo, thoda ruk kar dobara try karo
      if (/empty response|429|quota|RESOURCE_EXHAUSTED/i.test(msg) && emptyRounds < 2) {
        emptyRounds++;
        onEvent({ type: "wait", text: `LLM busy (${msg.slice(0, 60)}) — ${emptyRounds}/2 retry` });
        await sleep(5000 * emptyRounds);
        step--; // yahi step dobara
        continue;
      }
      throw err;
    }

    // Keep the model turn verbatim (it may contain text + function calls).
    contents.push({ role: "model", parts });

    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    const textOut = parts
      .filter((p) => typeof p.text === "string" && p.text.trim())
      .map((p) => p.text.trim())
      .join("\n");

    if (textOut) {
      finalText = textOut;
      onEvent({ type: "say", text: textOut.slice(0, 1200) });
    }

    if (!calls.length) {
      // Model answered without a tool call -> we are done.
      return { result: finalText || "(no answer)", steps, ms: Date.now() - t0 };
    }

    const responses = [];
    const images = [];
    let finished = null;

    for (const call of calls) {
      const name = call.name;
      const args = call.args || {};
      onEvent({ type: "tool", name, args });

      try {
        const out = await browser.runTool(name, args);
        if (out.images?.length) images.push(...out.images);

        if (name === "finish") {
          finished = String(args.summary || "Done").trim();
        }

        responses.push({
          functionResponse: {
            name,
            response: { result: out.text.slice(0, 12000) },
          },
        });
      } catch (err) {
        const msg = `ERROR: ${err.message?.slice(0, 600) || err}`;
        onEvent({ type: "tool_error", name, message: msg });
        responses.push({ functionResponse: { name, response: { error: msg } } });
      }
    }

    contents.push({ role: "user", parts: responses });
    if (images.length) {
      contents.push({
        role: "user",
        parts: [
          { text: "Screenshot of the current page:" },
          ...images.slice(0, 2).map((im) => ({ inlineData: im })),
        ],
      });
    }

    if (finished) {
      return { result: finalText || finished, steps, ms: Date.now() - t0 };
    }
  }

  return {
    result:
      (finalText ? finalText + "\n\n" : "") +
      `(Stopped: reached the ${maxSteps}-step limit. Increase MAX_STEPS in .env for longer jobs.)`,
    steps,
    ms: Date.now() - t0,
    hitLimit: true,
  };
}
