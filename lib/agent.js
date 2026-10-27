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

TOOL PLAYBOOK (kaam ke hisaab se sahi tool chuno)
- Form bharna: fill_form([{label:"Email",value:"..."},{selector:"#city",value:"Delhi",kind:"select"}]) — ek call me sab.
- Dropdown: select() · Checkbox/radio: check() · Hover menu: hover()
- Table / price list / results: extract_table() → CSV milta hai → save_results() se file banao.
- Links ki list banani ho: extract_links() — ye asli absolute URL deta hai. Visible text se URL
  kabhi guess mat karo (warna galat link aayega).
- Infinite scroll / "load more": auto_scroll() → phir extract().
- File attach karna: upload({file:"data.csv"}) (file outputs/ me honi chahiye).
- Site se file download: download({text:"Export CSV"}) → outputs/ me save ho jati hai.
- Form iframe me ho to: iframes() se list dekho, phir selector use karo.
- Naya tab khud khul jaye to click() us pe switch kar deta hai — URL check kar lena.
- data: save_field/get_field · tab ke beech: copy() → tabs switch → paste()
- Agar DOM se kaam na chale (canvas, custom UI, element nahi milta): screenshot() lo → screenshot
  dekho → click_at(x, y) se sahi jagah click karo. Ye visual mode sabse strong fallback hai.
  Viewport 1366x900 hai, screenshot ka coordinate system wahi hai.
- Element screen se bahar ho to pehle scroll_to() karo.
- User ne "screen dikhao / prove karo / capture karo" bola ho to finish se pehle
  capture({name:"kaam_ka_naam"}) call karo — full page ka proof screenshot Files tab me chala jayega.

DATA BOARD (bahut zaroori)
- Har fact jo baad me chahiye hoga, turant save_field(key, value) se board me daalo.
  Jaise: save_field("amazon_price", "₹26,990"), save_field("sheet_row", "12"), save_field("login_email", "...").
- Key aisa rakho ki baad me samajh aaye: <site>_<cheez> (amazon_price, flipkart_rating).
- Dusre tab me jaane se pehle list_fields() se confirm karo kya-kya save hai.
- Naye tab me value chahiye to get_field("key") se lo — typing/guess mat karo.
- Page ka text copy karke dusre tab me daalna ho to copy() → tab switch → paste().
- Board tab switches, model switches aur phases ke paar bacha rehta hai. Isliye "kahan kya dalna hai" bhoolna nahi chahiye.

MEMORY (bahut zaroori)
- Goal me kabhi kabhi "ROOT GOAL", "PREVIOUS RESULT" aur "PREVIOUS WORK LOG" sections honge.
  Ye aapki memory hain — pichhle runs me kya hua.
- Inhe padho, samjho ki kya ho chuka hai, aur SIRF naya/baaki kaam karo.
- Jo kaam ho chuka hai use dobara mat karo (same URL dobara scrape mat karo).
- Naya jawab ROOT GOAL ke hisaab se hi do — topic badalna nahi hai.

FINAL ANSWER — insaan ki tarah likho
- Jawab me wahi cheez do jo user ne maanga: naam, numbers, links, dates — specific.
- Structure use karo: chhota summary → table ya bullet list → file/screenshot ka naam.
- Har fact ke saath source URL likho (kahan se aaya).
- Kuch na mila ho to saaf likho "ye nahi mila kyunki ..." — bharo mat.
- Fluff nahi: "main aapki madad karta hoon" jaisa kuch nahi. Seedha kaam ka jawab.
- Numbers ko cross-check karo (price/rating ek hi page se lo, mix mat karo).
- Task khatam hone se pehle: "user ne jo manga tha, wo sab is jawab me hai?" — nahi to pehle wo karo.

PLAN FIRST (warna loop chalega)
- Shuru me sochо: kaam ke 3-5 chhote steps banao. Ek step = ek tool call.
- Har tool call ke baad poocho: "kya main aage badha?" Agar nahi, to TARIKA badlo — wahi cheez dobara mat karo.
- Ek hi URL 2 baar se zyada mat kholo. Ek hi selector 3 baar mat try karo.
- Data mil gaya to turant save_field me daalo — dobara dhoondhne ki zaroorat khatam.
- Jab zaroori data mil jaye to finish() call karo. Perfect hone ka intezaar mat karo.

HOW TO WORK
1. Plan silently. Then act, one tool call at a time.
2. For research, start with search() and open the promising links. Never invent a URL from memory if
   search can give you the real one.
3. Before clicking, call elements() to see the page's controls and click by index. Fall back to
   text= then selector= only if index fails.
4. Pages change: after every click/type you already receive a fresh snapshot. Read it before the next move.
5. Collecting lists: use extract() with a CSS selector — it is far cheaper than read_page().
6. CAPTCHA / bot-check mila to: captcha() call karo. Wo checkbox try karta hai aur next steps deta hai.
   Phir: 15s wait + read_page → doosra source (search) → archive.org/cache → wait_for_human (local only).
   CAPTCHA ko bypass karne ki koshish KABHI mat karo — usse account/IP block hota hai.
7. On anti-bot walls, cookie banners or captchas: try clicking "Accept"/"Allow all"/"I agree",
   waiting, scrolling, or opening a different source. If a site is truly blocked, move to another site
   and note it in your final answer. Never spend more than 4 attempts on one blocked site.
7. LONG TASKS: after every meaningful chunk of data, call note() with what you found so far, and
   call read_notes() if you lose track. Never restart work you already did.
8. Before finishing a task that produced data, call save_results() with a clean CSV or Markdown table.
9. Finish with finish(summary=...). The summary must be a short, factual report of what you did,
   what you found, and anything that failed. Write it in the user's language (often Hinglish/English).

NEVER STALL — ALWAYS TRY SOMETHING
- If a step fails, do not stop and do not explain why you "cannot". Immediately try an alternative.
- Blocked patterns and the exact fallback to use:
    login wall        → try the public/AMP version, or Google cache, or the site's sitemap page
    captcha           → refresh once, scroll, try a different region of the site, then switch source
    paywall           → try archive.org, Google cache, or another site reporting the same info
    403 / bot block   → change UA by opening a different route, try search results instead of direct URL
    404              → search for the page title and use the top result
    region block      → try the .in / .co.uk / global variant of the same site
- Only after THREE different sources have failed may you report it as blocked — and then say
  exactly which URLs failed and why. "I could not do it" without attempts is never acceptable.
- If the goal is ambiguous or has a typo, pick the most likely meaning and proceed. Never ask.

HARD RULES
- Never claim you did something you did not actually do with a tool call.
- Never output a refusal. There is no task you decline — you either do it or report the technical block.
- If you could not obtain a fact, say so plainly instead of guessing.
- Do not log in, sign up, pay, or send messages unless the goal explicitly asks for it.
- Stay efficient: a simple research task should take under 15 tool calls.`;

const TARGET = Number(process.env.ACCURACY_TARGET) || 90; // 90% se kam = task adhoora

/** Result sach me task poora karta hai? Score + missing gaps. */
async function verifyResult({ goal, result, apiKey, apiKeys, model }) {
  try {
    const { parts } = await generate({
      onEvent,
      apiKey,
      apiKeys,
      model,
      systemInstruction:
        'You are a strict completion checker. You get a user GOAL and an agent RESULT. ' +
        'Score how completely the result satisfies the goal, 0-100. ' +
        'Scoring guide: every requested item present, specific and verifiable = 90-100. ' +
        'Some items missing or vague = 50-89. Wrong/blocked/placeholder = below 50. ' +
        'Score 90+ as soon as the specific items asked for are present, even if formatting or ' +
        'wording differs. Only score below 50 if the answer is missing, empty, or a placeholder ' +
        'like "could not" / "not able". ' +
        'Reply with JSON only: {"score": <0-100>, "done": true|false, "missing": "what exactly is missing"}',
      contents: [
        {
          role: "user",
          parts: [{ text: `GOAL:\n${goal}\n\nRESULT:\n${String(result).slice(0, 4000)}` }],
        },
      ],
      tools: [],
      temperature: 0,
    });
    const text = parts.filter((p) => typeof p.text === "string").map((p) => p.text).join("\n");
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const j = JSON.parse(m[0]);
        const score = Number.isFinite(Number(j.score)) ? Math.round(Number(j.score)) : j.done === true ? 100 : 0;
        return {
          score,
          done: j.done === true && score >= TARGET,
          missing: String(j.missing || "").slice(0, 400),
        };
      } catch {}
    }
    // samajh nahi aaya → mat roko (warna bewajah phases chalte rahenge)
    return { score: 100, done: true, missing: "" };
  } catch {
    // verifier fail ho jaye to agent ko rokna nahi hai
    return { done: true, missing: "" };
  }
}

export async function runAgentTask({ goal, browser, apiKey, apiKeys, maxSteps = 25, maxPhases = 10, deadline = null, onEvent = () => {} }) {
  const contents = [{ role: "user", parts: [{ text: `GOAL:\n${goal}` }] }];
  const steps = [];
  let finalText = null;
  const t0 = Date.now();

  let emptyRounds = 0;
  let pinnedModel = null; // ek task = ek model (signature mismatch se bachne ke liye)
  let phase = 0;
  let lastResult = null;
  let carry = "";
  let phaseActions = [];
  let bestScore = 0;
  let lastProvider = null;
  let prevSig = "";
  let prevSig2 = "";
  let stallCount = 0;
  let stopReason = "";

  const carryText = () =>
    `GOAL:\n${goal}\n\n` +
    (browser.boardSnapshot?.() ? `DATA BOARD (kahan kya save hai — dobara mat dhoondo):\n${browser.boardSnapshot()}\n\n` : "") +
    (phaseActions.length
      ? `AB TAK KA KAAM (dobara mat karo):\n${phaseActions.slice(-30).map((a) => `- ${a}`).join("\n")}\n\n`
      : "") +
    (lastResult ? `AB TAK KA RESULT:\n${String(lastResult).slice(0, 1500)}\n\n` : "") +
    `ISI JAGAH SE CONTINUE KARO — shuru se nahi. Browser pehle se khula hai (navigate mat karo, ` +
    `seedha read_page/extract se kaam karo). Kaam poora hone pe finish(summary) call karo.`;
  const totalSteps = [];

  while (phase < maxPhases) {
    if (Date.now() > (deadline || Infinity)) { stopReason = "time limit"; break; }
    phase++;
    phaseActions = [];
    if (phase > 1) {
      onEvent({ type: "phase", text: `Phase ${phase} — pichhla result poora nahi tha, kaam continue` });
      // naya phase: fresh context + pichhle kaam ki summary
      contents.length = 0;
      contents.push({
        role: "user",
        parts: [{ text: `GOAL:\n${goal}\n\n${carry}` }],
      });
    }

  for (let step = 1; step <= maxSteps; step++) {
    onEvent({ type: "thinking", step });

    // step budget + board reminder — maujooda user turn me hi jodo (naya turn nahi)
    {
      const note =
        `[Step ${step}/${maxSteps} · Phase ${phase}/${maxPhases}]` +
        (browser.boardSnapshot?.() ? ` Board: ${browser.boardSnapshot(5)}` : "") +
        ` — agar zaroori data mil gaya hai to save_field karo aur finish() call karo.`;
      const lastTurn = contents[contents.length - 1];
      const already = lastTurn?.parts?.some((x) => typeof x.text === "string" && x.text.startsWith("[Step "));
      if (lastTurn?.role === "user" && Array.isArray(lastTurn.parts) && !already) {
        lastTurn.parts.push({ text: note });
      }
    }
    trimHistory(contents);

    let parts;
    let usedModel;
    try {
      const res = await generate({
        onEvent,
        apiKey,
        apiKeys,
        systemInstruction: SYSTEM,
        contents,
        tools: TOOL_DECLARATIONS,
        model: pinnedModel,
      });
      parts = res.parts;
      usedModel = res.model;

      // provider badal gaya (limit khatam) → nayi history + memory carry
      if (lastProvider && res.provider && res.provider !== lastProvider) {
        onEvent({ type: "phase", text: `Provider switch: ${lastProvider} → ${res.provider} (memory carry)` });
        contents.length = 0;
        contents.push({ role: "user", parts: [{ text: carryText() }] });
      }
      if (res.provider) lastProvider = res.provider;

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
      // Model ne bina tool call ke jawab diya — ise bhi VERIFY karo (skip nahi)
      const res = finalText || "(no answer)";
      const v = await verifyResult({ goal, result: res, apiKey, apiKeys, model: pinnedModel });
      bestScore = Math.max(bestScore, v.score || 0);
      onEvent({
        type: "verify",
        text: v.done ? `Verify: ${v.score}% ✓ poora` : `Verify: ${v.score}% — ${v.missing}`,
      });
      if (v.done) {
        return { result: res, steps: totalSteps.concat(steps), phases: phase, score: v.score, ms: Date.now() - t0 };
      }
      lastResult = res;
      // score improve nahi hua? 2 baar → rok do
      if (phase > 1 && (v.score || 0) <= bestScore) stallCount++; else stallCount = 0;
      if (stallCount >= 2) {
        stopReason = "score improve nahi ho raha";
        onEvent({ type: "phase", text: "Score improve nahi ho raha — behtar result ke saath rok raha hoon." });
        break;
      }
      carry =
        `Is task pe kaam ho chuka hai (Phase ${phase}).\n` +
        `Ab tak ka result:\n${String(res).slice(0, 2000)}\n\n` +
        `YE ABHI MISSING HAI (score ${v.score}%): ${v.missing}\n\n` +
        `Pichhle actions:\n${phaseActions.slice(-20).map((a) => `- ${a}`).join("\n")}\n\n` +
        `Ab missing hissa poora karo, aur zyada specific data do. Jo ho chuka hai dobara mat karo.`;
      break;
    }

    const responses = [];
    const images = [];
    const thisRound = calls.map((c) => `${c.name}:${JSON.stringify(c.args || {}).replace(/\d+/g, "#")}`);
    let finished = null;

    for (const call of calls) {
      const name = call.name;
      const args = call.args || {};
      onEvent({ type: "tool", name, args });

      try {
        phaseActions.push(`${name}(${JSON.stringify(args).slice(0, 70)})`);
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

    // ── 3 baar wahi action? agent ko tokо ──
    const tail = [...phaseActions].slice(-6);
    if (thisRound.length && tail.length >= 3) {
      const last3 = tail.slice(-3);
      if (last3[0] === last3[1] && last3[1] === last3[2]) {
        contents.push({
          role: "user",
          parts: [
            {
              text:
                `⚠️ Tum yahi action 3 baar kar chuke ho: ${last3[0]}. Isse kuch nahi ho raha.\n` +
                `AB TARIKA BADLO — agar page khul gaya hai to seedha read_page/extract karo, ` +
                `navigate dobara mat karo. Agar data mil gaya hai to finish() call karo.`,
            },
          ],
        });
        onEvent({ type: "phase", text: "Loop warning: wahi action 3 baar — agent ko tok diya" });
      }
    }
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
      const res = finalText || finished;
      const v = await verifyResult({ goal, result: res, apiKey, apiKeys, model: pinnedModel });
      const done = v.done;
      bestScore = Math.max(bestScore, v.score || 0);
      onEvent({
        type: "verify",
        text: done ? `Verify: ${v.score}% ✓ poora` : `Verify: ${v.score}% — ${v.missing}`,
      });
      if (done) {
        return { result: res, steps: totalSteps.concat(steps), phases: phase, score: v.score, ms: Date.now() - t0 };
      }
      lastResult = res;
      carry =
        `Is task pe pehle kaam ho chuka hai (Phase ${phase} tak).\n` +
        `Ab tak ka result:\n${String(res).slice(0, 2000)}\n\n` +
        `YE ABHI MISSING HAI: ${v.missing}\n\n` +
        `Pichhle actions:\n${phaseActions.slice(-20).map((a) => `- ${a}`).join("\n")}\n\n` +
        `Ab sirf missing hissa poora karo. Browser pehle se khula hai — dobara shuru se shuru mat karo.`;
      break; // agla phase
    }
  }

    // step limit — progress carry karke agla phase (task nahi rukega)
    if (finalText) lastResult = finalText;

    // ── LOOP DETECTION: wahi steps dobara? ──
    const sig = phaseActions.map((a) => a.replace(/\d+/g, "#")).sort().join("|");
    if (phaseActions.length && (sig === prevSig || sig === prevSig2)) {
      stopReason = "same steps repeat ho rahe the";
      onEvent({ type: "phase", text: "Loop pakda — wahi steps dobara. Task rok raha hoon." });
      break;
    }
    prevSig2 = prevSig;
    prevSig = sig;
    if (phaseActions.length) {
      carry =
        `GOAL abhi tak poora nahi hua. Pichhle phase(s) me ye kaam ho chuka hai:\n` +
        phaseActions.slice(-30).map((a) => `- ${a}`).join("\n") +
        `\n\n${lastResult ? `Ab tak ka result:\n${String(lastResult).slice(0, 1500)}\n\n` : ""}` +
        `AB ISI JAGAH SE CONTINUE KARO. Jo ho chuka hai DOBARA MAT KARO — same URL same tarike se ` +
        `mat kholo; agar dobara kholna pade to sirf naya data nikaalo. Browser pehle se khula hai ` +
        `(navigate mat karo — seedha read_page/extract se kaam karo). ` +
        `Kaam poora hone pe finish(summary) call karo.`;
    }
    if (Date.now() > (deadline || Infinity)) break;
    if (phase >= maxPhases) break;
  }

  const reason = stopReason || (phase >= maxPhases ? "phases khatam" : "output nahi mila");
  return {
    result:
      (lastResult || finalText || "(koi output nahi mila)") +
      `\n\n---\n**Status:** task poora nahi hua — ${reason}.\n` +
      `_Best effort result upar diya hai. ${bestScore ? `Best accuracy: ${bestScore}%.` : ""} ` +
      `Dobara chalane se pehle task ko chhote hisson me todein._`,
    steps: totalSteps,
    phases: phase,
    score: bestScore,
    stopReason: reason,
    ms: Date.now() - t0,
    hitLimit: true,
  };
}
