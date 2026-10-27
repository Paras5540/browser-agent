/* Browser Agent — cloud dashboard (GitHub Pages, no server) */
const LS = { owner: "ba_owner", repo: "ba_repo", branch: "ba_branch", token: "ba_token" };

const cfg = {
  owner: localStorage.getItem(LS.owner) || "",
  repo: localStorage.getItem(LS.repo) || "",
  branch: localStorage.getItem(LS.branch) || "main",
  token: localStorage.getItem(LS.token) || "",
};

const $ = (id) => document.getElementById(id);

/* ── i18n (English default) ── */
const I18N = window.NETRA_I18N || { t: (k) => k, setLang: () => {}, applyI18n: () => {}, lang: "en" };
const t = (k) => I18N.t(k);
const setLang = (l) => I18N.setLang(l);

/* ── inline SVG icons (no emoji) ── */
const ICONS = {
  live:   '<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/>',
  tasks:  '<path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  files:  '<rect x="4" y="3" width="16" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  setup:  '<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  back:   '<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  play:   '<path d="M7 4l13 8-13 8z" fill="currentColor"/>',
  stop:   '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
  clear:  '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  data:   '<rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 10h18M9 10v10" stroke="currentColor" stroke-width="2"/>',
  camera: '<path d="M4 8h3l2-2h6l2 2h3v11H4z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="13" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/>',
  text:   '<path d="M5 6h14M5 12h14M5 18h9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
};

function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    const name = el.dataset.icon;
    if (!ICONS[name] || el.dataset.done) return;
    el.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">${ICONS[name]}</svg>`;
    el.dataset.done = "1";
  });
}
hydrateIcons();
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const configured = () => cfg.owner && cfg.repo && cfg.token;

/** null-safe event binding — ek missing element poori app na tode */
const on = (id, ev, fn) => {
  const el = $(id);
  if (el) el.addEventListener(ev, fn);
  return el;
};

/* ── theme: dark / light ────────────────────────────────────────────── */
const THEME_KEY = "ba_theme";
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {}
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute("content", t === "dark" ? "#171614" : "#f5f4ee");
  const b = $("themeBtn");
  if (b) b.textContent = t === "dark" ? "☀" : "☾";
}
function initTheme() {
  let t = null;
  try {
    t = localStorage.getItem(THEME_KEY);
  } catch {}
  if (!t) t = "dark"; // default: dark mode
  applyTheme(t);
}
initTheme();

/* ── markdown-lite → HTML (result bodies ke liye) ───────────────────────── */
function mdToHtml(mdx) {
  let s = esc(mdx || "");
  s = s.replace(/```([\s\S]*?)```/g, (_, c) => `<pre>${c.trim()}</pre>`);
  s = s.replace(/^#### (.*)$/gm, '<div class="md-h">$1</div>');
  s = s.replace(/^### (.*)$/gm, '<div class="md-h">$1</div>');
  s = s.replace(/^## (.*)$/gm, '<div class="md-h">$1</div>');
  s = s.replace(/^# (.*)$/gm, '<div class="md-h1">$1</div>');
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/^- (.*)$/gm, '<span class="md-li">• $1</span>');
  s = s.replace(/&lt;sub&gt;(.*?)&lt;\/sub&gt;/g, '<span class="md-sub">$1</span>');
  s = s.replace(/^---$/gm, '<hr class="md-hr" />');
  s = s.replace(/\n{3,}/g, "\n\n");
  return s;
}

/* ── auto-detect repo from github.io URL ────────────────────────────────── */
function autoDetect() {
  const host = location.hostname;
  if (!host.endsWith("github.io")) return;
  const user = host.split(".")[0];
  const path = location.pathname.split("/").filter(Boolean);
  if (!cfg.owner) cfg.owner = user;
  if (!cfg.repo) cfg.repo = path.length ? path[0] : `${user}.github.io`;
}

/* ── GitHub API ─────────────────────────────────────────────────────────── */
let rateRemaining = 5000;

async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${cfg.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {}),
    },
  });
  const rl = Number(res.headers.get("x-ratelimit-remaining"));
  if (Number.isFinite(rl) && rl > 0) rateRemaining = rl;
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error("Token galat ya expired hai");
    if (res.status === 403 || res.status === 404)
      throw new Error(`${msg} (HTTP ${res.status}) — token me Secrets/Variables: Read and write permission chahiye`);
    throw new Error(`${msg} (HTTP ${res.status})`);
  }
  return json;
}

const repoPath = () => `/repos/${cfg.owner}/${cfg.repo}`;

async function ensureLabel(name, color = "6b6b6b") {
  try {
    await gh(`${repoPath()}/labels/${encodeURIComponent(name)}`);
  } catch {
    try {
      await gh(`${repoPath()}/labels`, { method: "POST", body: JSON.stringify({ name, color }) });
    } catch {}
  }
}

async function createTask(goal, titleOverride) {
  await ensureLabel("agent-task");
  await ensureLabel("agent-running", "b0b0b0");
  await ensureLabel("agent-done", "1f1e1d");
  await ensureLabel("agent-failed", "a33a2c");
  const title = (titleOverride || goal.split("\n")[0] || "agent task").slice(0, 90);
  return gh(`${repoPath()}/issues`, {
    method: "POST",
    body: JSON.stringify({ title, body: goal, labels: ["agent-task"] }),
  });
}

async function dispatchWorkflow(goal = "") {
  return gh(`${repoPath()}/actions/workflows/agent.yml/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: cfg.branch, inputs: { goal } }),
  });
}

/* ══════════════════════ THREADS (har task = alag chat) ══════════════════════ */
const chat = $("chat");
const issueUIs = new Map();
const issueResults = new Map();
let trackedIssue = null;
let replyTo = null;
let currentThread = null;
let liveActive = false;
let liveStartedAt = null;

const threadVisible = () => !$("chat").classList.contains("hide");

function showList() {
  showNewTask();
}

/** Ghar ki screen: naya task (task list nahi) */
function showNewTask() {
  currentThread = null;
  chat.innerHTML = `
    <div class="empty" id="chatEmpty">
      <h3 data-i18n="emptyTitle">${t("emptyTitle")}</h3>
      <p data-i18n="emptyBody">${t("emptyBody")}</p>
      <div class="suggestions">
        <button class="sug" data-i18n="sug1">${t("sug1")}</button>
        <button class="sug" data-i18n="sug2">${t("sug2")}</button>
        <button class="sug" data-i18n="sug3">${t("sug3")}</button>
      </div>
    </div>`;
  chat.querySelectorAll(".sug").forEach((b) =>
    b.addEventListener("click", () => {
      input.value = b.textContent.trim();
      autoGrow();
      input.focus();
    })
  );
  $("threadList").classList.add("hide");
  $("chat").classList.remove("hide");
  $("backBtn").classList.add("hide");
  $("stopRun")?.classList.add("hide");
  $("clearChat")?.classList.add("hide");
  $("threadTitle").textContent = t("newTask");
  setRunning(false);
  hydrateIcons(chat);
}

function showThreadView(n, title) {
  currentThread = n;
  $("threadList").classList.add("hide");
  $("chat").classList.remove("hide");
  $("backBtn").classList.remove("hide");
  $("stopRun")?.classList.remove("hide");
  $("clearChat")?.classList.remove("hide");
  $("threadTitle").textContent = title || `#${n}`;
}

function isNearBottom() {
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 140;
}

let userScrolledUp = false;
chat?.addEventListener("scroll", () => {
  userScrolledUp = !isNearBottom();
  $("jumpBtn")?.classList.toggle("hide", !userScrolledUp || !threadVisible());
});

function scrollChat(force = false) {
  if (force || !userScrolledUp) {
    chat.scrollTop = chat.scrollHeight;
    $("jumpBtn")?.classList.add("hide");
    userScrolledUp = false;
  }
}

on("jumpBtn", "click", () => scrollChat(true));

function addUserMsg(text) {
  const el = document.createElement("div");
  el.className = "msg user";
  el.innerHTML = `<div class="bubble">${esc(text)}</div>`;
  chat.appendChild(el);
  scrollChat();
  return el;
}

function whoHtml(n, badgeCls, badgeText) {
  const link = n
    ? ` <a class="issue-link" href="https://github.com/${cfg.owner}/${cfg.repo}/issues/${n}" target="_blank" rel="noopener">#${n}</a>`
    : "";
  const fu = n ? `<button class="btn tiny ghost fu" data-followup="${n}" title="Isi task me aage kaam">↩ Follow-up</button>` : "";
  return `<span class="dot-sm"></span>Agent${link}<span class="badge ${badgeCls}" data-badge>${badgeText}</span>${fu}`;
}

function addAgentMsg(n) {
  const el = document.createElement("div");
  el.className = "msg agent";
  el.innerHTML = `<div class="who">${whoHtml(n, "running", "running")}</div>
    <div class="bubble running" data-bubble>
      <div class="skel"><i></i><i></i><i></i></div>
      <div class="startmsg"><span class="si">◐</span>Agent starting…</div>
    </div>`;
  chat.appendChild(el);
  scrollChat();
  const ui = { root: el, bubble: el.querySelector("[data-bubble]"), badge: el.querySelector("[data-badge]") };
  if (n) issueUIs.set(n, ui);
  return ui;
}

/* ── live ticker: har second kuch na kuch chalta dikhe ── */
const THINK_WORDS = [
  "soch raha hoon",
  "plan bana raha hoon",
  "page dekh raha hoon",
  "agla step chun raha hoon",
  "kaam kar raha hoon",
];
let streamTick = null;

function setRunning(on) {
  $("runbar")?.classList.toggle("hide", !on);
}

let shotTick = 0;
let shotUrl = null;

async function refreshLiveShot() {
  const wrap = $("shotWrap");
  const img = $("liveShot");
  if (!wrap || !img || !configured()) return;
  try {
    // raw.githubusercontent CDN cache karta hai — API se fresh blob lo
    const res = await fetch(
      `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/outputs/live/latest.jpg?ref=live&cb=${Date.now()}`,
      {
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: "application/vnd.github.v3.raw",
          "Cache-Control": "no-cache",
        },
        cache: "no-store",
      }
    );
    if (!res.ok) {
      if (res.status === 404) wrap.classList.add("hide");
      return;
    }
    const blob = await res.blob();
    if (shotUrl) URL.revokeObjectURL(shotUrl);
    shotUrl = URL.createObjectURL(blob);
    img.src = shotUrl;
    wrap.classList.remove("hide");
  } catch {
    wrap.classList.add("hide");
  }
}

function stopThinkTick() {
  if (streamTick) clearInterval(streamTick);
  streamTick = null;
}

function startThinkTick(el, t0) {
  stopThinkTick();
  streamTick = setInterval(() => {
    const box = el.querySelector(".sthink");
    if (!box) return stopThinkTick();
    const sec = Math.round((Date.now() - t0) / 1000);
    const w = THINK_WORDS[Math.floor(sec / 5) % THINK_WORDS.length];
    box.innerHTML = `<span class="si">◐</span><span class="w">${w}<span class="dots"><i>.</i><i>.</i><i>.</i></span></span><span class="stime">${sec}s</span>`;
  }, 1000);
}

/** Live steps chat ke andar — Claude jaisa realtime */
function renderStream(el, body) {
  const steps = (body || "")
    .split("\n")
    .filter((l) => /^- ✓/.test(l))
    .map((l) => l.replace(/^- ✓\s*/, "").replace(/`/g, "").trim());
  const abhi = (body?.match(/\*\*Abhi:\*\*\s*(.+)/) || [])[1];
  const elapsed = (body?.match(/\*\*Elapsed:\*\*\s*([^·|]+)/) || [])[1] || "";
  const cur = abhi && (!steps.length || steps[steps.length - 1] !== abhi.trim()) ? abhi.trim() : "";

  el.innerHTML =
    `<div class="stream">` +
    steps.map((s) => `<div class="srow done"><span class="si">✓</span><span>${esc(s)}</span></div>`).join("") +
    (cur ? `<div class="srow active"><span class="si">◐</span><span>${esc(cur)}</span></div>` : "") +
    `</div>` +
    (elapsed ? `<div class="smeta">${esc(elapsed)}</div>` : "") +
    `<div class="sthink"><span class="si">◐</span><span class="w">soch raha hoon<span class="dots"><i>.</i><i>.</i><i>.</i></span></span><span class="stime">0s</span></div>`;
}

/** Ek task ki live poll — steps chat me add hote jaate hain */
async function streamThread(n, ui) {
  const t0 = Date.now();
  let lastBody = "";
  while (Date.now() - t0 < 55 * 60 * 1000) {
    let iss, cs;
    try {
      iss = await gh(`${repoPath()}/issues/${n}`);
      cs = await gh(`${repoPath()}/issues/${n}/comments?per_page=1&sort=created&direction=desc`);
    } catch {
      await sleep(2500);
      continue;
    }
    const labels = (iss.labels || []).map((l) => l.name);
    const body = cs?.[0]?.body || "";
    const failed = labels.includes("agent-failed");
    const done = labels.includes("agent-done") || failed || iss.state === "closed";

    // queue me hai? kis run ke peeche — saaf batao
    const waited = Math.round((Date.now() - t0) / 1000);
    if (!body && waited > 18 && (!ui._queuedNoted || waited - (ui._qAt || 0) > 20)) {
      ui._queuedNoted = true;
      ui._qAt = waited;
      let ahead = "";
      try {
        const runs = await gh(`${repoPath()}/actions/runs?per_page=6`);
        const running = (runs.workflow_runs || []).find((r) => r.status === "in_progress");
        if (running) {
          const m = /issue #(\d+)/.exec(running.name || "");
          ahead = ` Aage chal raha hai: <b>${esc(running.name)}</b>${m ? ` (issue <a class="issue-link" href="https://github.com/${cfg.owner}/${cfg.repo}/issues/${m[1]}" target="_blank" rel="noopener">#${m[1]}</a>)` : ""} — ${fmtElapsed(running.created_at)} se.`;
        }
      } catch {}
      ui.bubble.innerHTML = `<div class="srow active"><span class="si">◐</span><span>Queue me hai (${waited}s).${ahead || " Ek time pe ek run chalta hai."}<br>Iska matlab agent atka nahi hai — bas pehla run khatam hone ka intezaar hai.</span></div>`;
      ui.badge.textContent = "queued";
    }

    if (body && body !== lastBody) {
      lastBody = body;
      if (done) {
        ui.bubble.innerHTML = mdToHtml(body);
        issueResults.set(n, body);
        ui.badge.className = `badge ${failed ? "error" : "done"}`;
        ui.badge.textContent = failed ? "failed" : "done";
        ui.bubble.classList.remove("running");
        stopThinkTick();
        setRunning(false);
        setTimeout(() => $("shotWrap")?.classList.add("hide"), 1500);
        scrollChat();
        loadThreads();
        return;
      }
      renderStream(ui.bubble, body);
      startThinkTick(ui.bubble, t0);
      setRunning(true);
      $("shotWrap")?.classList.remove("hide");
      refreshLiveShot();
      scrollChat();
    }
    await sleep(1200);
  }
}

async function openThread(n, opts = {}) {
  const iss = await gh(`${repoPath()}/issues/${n}`).catch(() => null);
  if (!iss) return;
  chat.innerHTML = "";
  showThreadView(n, iss.title);
  if (!opts.skipUser) addUserMsg(iss.body || iss.title);

  // same issue me diye gaye purane instructions bhi chat me dikhao
  let allComments = [];
  try {
    allComments = (await gh(`${repoPath()}/issues/${n}/comments?per_page=100`)) || [];
  } catch {}
  for (const c of allComments) {
    const m = (c.body || "").match(/<!--\s*agent-continue\s*-->[\s\S]*?NEW INSTRUCTION:\s*([\s\S]*)/i);
    if (m) addUserMsg(m[1].replace(/<!--[\s\S]*?-->/g, "").replace(/<sub>[\s\S]*?<\/sub>/g, "").trim());
  }

  const ui = addAgentMsg(n);
  const labels = (iss.labels || []).map((l) => l.name);
  const done = labels.includes("agent-done") || labels.includes("agent-failed") || iss.state === "closed";

  if (done) {
    const resultComments = allComments.filter((c) => /#\s*(✅|⚠️)\s*Task result/i.test(c.body || ""));
    const body = (resultComments.at(-1)?.body) || (allComments.at(-1)?.body || "");
    const failed = labels.includes("agent-failed");
    ui.bubble.innerHTML = body ? mdToHtml(body) : `<span class="muted">Koi output nahi</span>`;
    if (body) issueResults.set(n, body);
    ui.badge.className = `badge ${failed ? "error" : "done"}`;
    ui.badge.textContent = failed ? "failed" : "done";
    ui.bubble.classList.remove("running");
    scrollChat();
  } else {
    startThinkTick(ui.bubble, Date.now());
    streamThread(n, ui);
  }
}

/** Tasks list (alag alag chats) */
async function loadThreads() {
  const el = $("threadList");
  if (!el || threadVisible()) return;
  if (!configured()) {
    el.innerHTML = `<div class="empty"><h3>Setup chahiye</h3>
      <p>GitHub repo aur token daalne ke baad task chalenge.</p>
      <button class="btn primary" id="emptySetup">⚙ Setup kholein</button></div>`;
    el.querySelector("#emptySetup")?.addEventListener("click", () => openSetup());
    return;
  }
  try {
    const issues = await gh(`${repoPath()}/issues?labels=agent-task&state=all&per_page=40&sort=created&direction=desc`);
    if (!issues.length) {
      el.innerHTML = `<div class="empty"><h3>Kya karna hai batayein</h3>
        <p>Har task apni alag chat banti hai. Neeche likhkar shuru karein.</p>
        <div class="suggestions">
          <button class="sug">Hacker News pe aaj ke top 10 posts ka title aur link CSV me nikaalo</button>
          <button class="sug">Amazon pe top 5 noise cancelling headphones ke naam, price, rating nikaalo</button>
          <button class="sug">Google pe "best CRM for small business 2025" search karke top 5 results ka summary do</button>
        </div></div>`;
      el.querySelectorAll(".sug").forEach((b) =>
        b.addEventListener("click", () => {
          input.value = b.textContent.trim();
          input.focus();
        })
      );
      return;
    }
    el.innerHTML = issues
      .map((i) => {
        const st = statusOf(i);
        return `<div class="thread" data-thread="${i.number}">
          <div class="th-top"><span class="th-title">${esc(i.title)}</span><span class="badge ${st.cls}">${st.text}</span></div>
          <div class="th-meta">#${i.number} · ${new Date(i.created_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</div>
        </div>`;
      })
      .join("");
    el.querySelectorAll("[data-thread]").forEach((t) =>
      t.addEventListener("click", () => openThread(Number(t.dataset.thread)))
    );
  } catch (err) {
    el.innerHTML = `<p class="hint" style="color:var(--danger)">${esc(err.message)}</p>`;
  }
}

/** Setup kholo */
function openSetup() {
  navTo("setup");
}

/* ══════════════════ MODEL SWITCHER ══════════════════ */
const MODEL_CATALOG = [
  {
    id: "gemini",
    label: "Gemini",
    base: "",
    keySecret: "GEMINI_API_KEY",
    models: ["gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-flash-latest"],
  },
  {
    id: "groq",
    label: "Groq",
    base: "https://api.groq.com/openai/v1",
    keySecret: "GROQ_API_KEY",
    models: ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b", "allam-2-7b"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    base: "https://openrouter.ai/api/v1",
    keySecret: "OPENROUTER_API_KEY",
    models: ["minimax/minimax-m3.1-flash:free", "nvidia/nemotron-3-ultra-550b-a55b:free", "google/gemma-4-31b-it:free"],
  },
  {
    id: "dahl",
    label: "Dahl Inference",
    base: "https://inference.dahl.global/v1",
    keySecret: "DAHL_API_KEY",
    models: ["MiniMaxAI/MiniMax-M2.7", "deepseek-ai/DeepSeek-V4-Flash-0731", "zai-org/GLM-5.3-Flash"],
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    base: "https://integrate.api.nvidia.com/v1",
    keySecret: "NVIDIA_API_KEY",
    models: ["meta/llama-3.3-70b-instruct", "qwen/qwen2.5-72b-instruct"],
  },
];

let modelState = { provider: "gemini", base: "", model: "" };
let secretNamesCache = [];

function providerOf(base) {
  if (!base) return "gemini";
  if (/dahl\.global/.test(base)) return "dahl";
  if (/openrouter\.ai/.test(base)) return "openrouter";
  if (/nvidia/.test(base)) return "nvidia";
  if (/groq\.com/.test(base)) return "groq";
  return "openrouter";
}

async function loadModelState() {
  if (!configured()) return;
  try {
    const v = await gh(`${repoPath()}/actions/variables`);
    const vars = {};
    for (const x of v.variables || []) vars[x.name] = x.value;
    const isOpenAI = (vars.LLM_PROVIDER || "gemini") === "openai";
    modelState = {
      provider: isOpenAI ? providerOf(vars.LLM_BASE_URL) : "gemini",
      base: vars.LLM_BASE_URL || "",
      model: isOpenAI ? vars.LLM_MODEL || "" : vars.GEMINI_MODEL || "gemini-flash-lite-latest",
    };
    try {
      const sc = await gh(`${repoPath()}/actions/secrets`);
      secretNamesCache = (sc.secrets || []).map((x) => x.name);
    } catch {}
    renderModelLabel();
  } catch {}
}

function updateChipWarn() {
  const cat = MODEL_CATALOG.find((c) => c.id === modelState.provider);
  const ok = !cat || secretNamesCache.includes(cat.keySecret);
  const w = $("chipWarn");
  if (w) w.style.display = ok ? "none" : "inline";
}

function renderModelLabel() {
  const cat = MODEL_CATALOG.find((c) => c.id === modelState.provider) || MODEL_CATALOG[0];
  const el = $("modelLabel");
  if (el) el.textContent = modelState.model || cat.label;
  updateChipWarn();
}

function renderModelList() {
  const box = $("modelList");
  if (!box) return;
  box.innerHTML = MODEL_CATALOG.map((c) => {
    const hasKey = secretNamesCache.includes(c.keySecret);
    return (
      `<div class="menu-label" style="padding-left:10px">${esc(c.label)}${hasKey ? "" : " · key missing"}</div>` +
      c.models
        .map(
          (m) =>
            `<button class="model-opt ${modelState.provider === c.id && modelState.model === m ? "active" : ""}" data-p="${esc(c.id)}" data-m="${esc(m)}">
              <span>${esc(m)}${modelState.provider === c.id && modelState.model === m ? " ✓" : ""}</span>
            </button>`
        )
        .join("")
    );
  }).join("");

  box.querySelectorAll("[data-p]").forEach((b) =>
    b.addEventListener("click", () => switchModel(b.dataset.p, b.dataset.m))
  );
}

async function switchModel(provId, modelName) {
  const cat = MODEL_CATALOG.find((c) => c.id === provId);
  if (!cat) return;
  closeModelMenu();
  try {
    if (provId === "gemini") {
      await setVariable("LLM_PROVIDER", "gemini");
      await setVariable("GEMINI_MODEL", modelName);
    } else {
      await setVariable("LLM_PROVIDER", "openai");
      await setVariable("LLM_BASE_URL", cat.base);
      await setVariable("LLM_MODEL", modelName);
    }
    modelState = { provider: provId, base: cat.base, model: modelName };
    renderModelLabel();
    toast(`✓ ${cat.label} · ${modelName} — agla task isi se chalega`);
  } catch (e) {
    toast(`✗ ${e.message}`, true);
  }
}

function closeModelMenu() {
  $("modelMenu")?.classList.add("hide");
}

on("modelBtn", "click", (e) => {
  e.stopPropagation();
  const menu = $("modelMenu");
  const btn = $("modelBtn");
  if (!menu || !btn) return;
  if (!menu.classList.contains("hide")) return closeModelMenu();
  renderModelList();
  menu.classList.remove("hide");
  const r = btn.getBoundingClientRect();
  const w = menu.offsetWidth || 250;
  menu.style.top = `${Math.round(r.top - menu.offsetHeight - 6)}px`;
  menu.style.left = `${Math.round(Math.min(r.left, window.innerWidth - w - 10))}px`;
});

on("modelMore", "click", () => {
  closeModelMenu();
  navTo("setup");
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("#modelMenu") && !e.target.closest("#modelBtn")) closeModelMenu();
});

/* ── panel menu (⋮) ── */
function closeMenu() {
  $("panelMenu")?.classList.add("hide");
  $("menuBtn")?.setAttribute("aria-expanded", "false");
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});

window.addEventListener("resize", closeMenu);
window.addEventListener("scroll", closeMenu, true);

/* ── toast ── */
function toast(text, isErr = false) {
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.toggle("err", isErr);
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 4000);
}

/* ── follow-up ── */
function setReply(n) {
  replyTo = n;
  const chip = $("replyChip");
  if (!chip) return;
  chip.classList.toggle("hide", !n);
  if (n) {
    $("replyTo").textContent = `#${n}`;
    $("input").focus();
  }
}

on("replyCancel", "click", () => setReply(null));
on("backBtn", "click", () => { closeMenu(); showNewTask(); });

on("pageBack", "click", () => {
  document.body.classList.remove("page-mode");
  closeMenu();
});
on("stopRun", "click", async () => {
  closeMenu();
  try {
    const runs = await gh(`${repoPath()}/actions/runs?per_page=10`);
    const active = (runs.workflow_runs || []).filter((r) => ["in_progress", "queued", "pending"].includes(r.status));
    if (!active.length) return toast("Koi run nahi chal raha");
    // is issue ka run pehle, warna latest
    const mine = currentThread ? active.find((r) => (r.name || "").includes(`issue #${currentThread}`)) : null;
    const target = mine || active[0];
    await gh(`${repoPath()}/actions/runs/${target.id}/cancel`, { method: "POST" });
    toast(`⏹ Run #${target.run_number} cancel kar diya`);
    loadTasks();
    loadLive();
  } catch (e) {
    toast(`✗ ${e.message}`, true);
  }
});

on("clearChat", "click", () => {
  closeMenu();
  showNewTask();
});

chat.addEventListener("click", (e) => {
  const b = e.target.closest("[data-followup]");
  if (!b) return;
  setReply(Number(b.dataset.followup));
  $("input").placeholder = `#${b.dataset.followup} me aage kaam — naya instruction…`;
});

/** purane task ko kholna (Tasks tab se bhi) */
async function focusIssue(n) {
  switchTab("live", true);
  await openThread(n);
}

/* ── composer ── */
const form = $("composer");
const input = $("input");

function autoGrow() {
  if (!input) return;
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 120) + "px";
}

// + menu (quick actions)
on("plusBtn", "click", (e) => {
  e.stopPropagation();
  const m = $("plusMenu");
  if (!m) return;
  if (!m.classList.contains("hide")) return m.classList.add("hide");
  m.classList.remove("hide");
  const r = $("plusBtn").getBoundingClientRect();
  const w = m.offsetWidth || 220;
  m.style.top = `${Math.round(r.top - m.offsetHeight - 8)}px`;
  m.style.left = `${Math.round(Math.min(r.left, window.innerWidth - w - 10))}px`;
});

document.querySelectorAll("[data-tpl]").forEach((b) =>
  b.addEventListener("click", () => {
    $("plusMenu")?.classList.add("hide");
    input.value = b.dataset.tpl;
    autoGrow();
    input.focus();
  })
);

on("plusStop", "click", () => {
  $("plusMenu")?.classList.add("hide");
  $("stopRun")?.click();
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("#plusMenu") && !e.target.closest("#plusBtn")) $("plusMenu")?.classList.add("hide");
});

// mic — browser speech-to-text (Chrome/Android)
let recog = null;
let listening = false;
on("micBtn", "click", () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast("Is browser me voice input support nahi hai", true);
  if (listening) {
    recog?.stop();
    return;
  }
  recog = new SR();
  recog.lang = "hi-IN";
  recog.interimResults = true;
  recog.continuous = false;
  let base = input.value ? input.value + " " : "";
  recog.onstart = () => {
    listening = true;
    $("micBtn").classList.add("rec");
    toast("🎙 Sun raha hoon…");
  };
  recog.onresult = (ev) => {
    let txt = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) txt += ev.results[i][0].transcript;
    input.value = base + txt;
    autoGrow();
  };
  recog.onerror = () => toast("Voice input fail hui", true);
  recog.onend = () => {
    listening = false;
    $("micBtn").classList.remove("rec");
    input.focus();
  };
  try { recog.start(); } catch { listening = false; }
});
input?.addEventListener("input", autoGrow);

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const goal = input.value.trim();
  if (!goal) return;
  if (!configured()) {
    openSetup();
    showSetupMsg("err", "Pehle Setup tab me repo + token daalein.");
    return;
  }

  input.value = "";
  autoGrow();
  chat.innerHTML = "";
  showThreadView(null, goal.slice(0, 40) + (goal.length > 40 ? "…" : ""));
  addUserMsg(goal);
  const ui = addAgentMsg(null);
  setRunning(true);

  try {
    let issue;
    if (replyTo) {
      // SAME issue me continue — naya issue nahi banega (memory ek jagah)
      const n = replyTo;
      await gh(`${repoPath()}/issues/${n}/comments`, {
        method: "POST",
        body: JSON.stringify({
          body: `<!-- agent-continue -->\n**NEW INSTRUCTION:** ${goal}\n\n<sub>same task continue · ${new Date().toLocaleString()}</sub>`,
        }),
      });
      // closed tha to kholo
      try {
        await gh(`${repoPath()}/issues/${n}`, { method: "PATCH", body: JSON.stringify({ state: "open" }) });
      } catch {}
      setReply(null);

      // usi thread me stream karo
      ui.root.remove();
      await openThread(n, { skipUser: false });
      loadTasks();
      return;
    } else {
      issue = await createTask(goal);
    }
    ui.root.querySelector(".who").innerHTML = whoHtml(issue.number, "running", "queued");
    ui.badge = ui.root.querySelector("[data-badge]");
    issueUIs.set(issue.number, ui);
    trackedIssue = issue.number;
    streamThread(issue.number, ui);
    loadTasks();
  } catch (err) {
    ui.bubble.innerHTML = `<span style="color:var(--danger)">✗ ${esc(err.message)}</span>`;
    ui.badge.className = "badge error";
    ui.badge.textContent = "error";
    stopThinkTick();
    setRunning(false);
  }
});

input?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) form.requestSubmit();
});

/* ══════════════════════ LIVE ══════════════════════ */
let lastManualTabAt = 0;
let lastActiveRunId = null;

function fmtElapsed(from, to) {
  const a = new Date(from).getTime();
  const b = to ? new Date(to).getTime() : Date.now();
  const s = Math.max(0, Math.round((b - a) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function stepIcon(s) {
  if (s.status === "in_progress") return "◐";
  if (s.conclusion === "success") return "✓";
  if (s.conclusion === "failure") return "✗";
  if (s.conclusion === "skipped") return "·";
  return "○";
}

function stepCls(s) {
  if (s.status === "in_progress") return "active";
  if (s.conclusion === "failure") return "fail";
  if (s.conclusion === "success") return "done";
  return "";
}

function renderLiveLog(el, logBody) {
  const lines = (logBody || "")
    .split("\n")
    .filter((l) => /^- /.test(l) || l.startsWith("**Elapsed") || l.startsWith("**Abhi") || l.startsWith("### "))
    .slice(-120);
  el.innerHTML = lines.length
    ? `<div class="live-log-title">Agent log</div>` +
      lines
        .map((l) => {
          if (l.startsWith("### ")) return `<div class="li head">${esc(l.replace(/^### /, ""))}</div>`;
          if (l.startsWith("**Elapsed")) return `<div class="li meta">${esc(l.replace(/\*\*/g, ""))}</div>`;
          if (l.startsWith("**Abhi")) return `<div class="li head">${esc(l.replace(/\*\*/g, ""))}</div>`;
          const fail = l.includes("✗");
          return `<div class="li${fail ? " fail" : ""}">${esc(l.replace(/^- /, "").replace(/`/g, ""))}</div>`;
        })
        .join("")
    : "";
}

async function loadLive() {
  if (!configured()) return;
  const header = $("liveHeader");
  const stepsEl = $("liveSteps");
  const logEl = $("liveLog");

  try {
    const runs = await gh(`${repoPath()}/actions/runs?per_page=12`);
    const agentRuns = (runs.workflow_runs || []).filter((r) => r.path?.includes("agent.yml"));

    if (!agentRuns.length) {
      header.style.display = "none";
      stepsEl.innerHTML = `<p class="hint">Abhi koi run nahi hua.</p>`;
      logEl.innerHTML = "";
      $("liveStrip").classList.add("hide");
      return;
    }

    const active = agentRuns.find((r) => r.status === "in_progress" || r.status === "queued") || agentRuns[0];
    const isLive = active.status !== "completed";

    if (isLive) {
      const isNewRun = lastActiveRunId !== active.id;
      lastActiveRunId = active.id;
      if (isNewRun || Date.now() - lastManualTabAt > 45000) switchTab("live");
      // mobile pe panel khud na khule — chat full-screen rehti hai (strip me status dikhta hai)
    }

    const m = /issue #(\d+)/.exec(active.name || "");
    const issueNum = m ? Number(m[1]) : null;

    const jobsRes = await gh(`${repoPath()}/actions/runs/${active.id}/jobs`);
    const steps = (jobsRes.jobs || [])[0]?.steps || [];

    header.style.display = "";
    $("liveTitle").innerHTML = `${esc(active.name || "run")}<span class="badge ${
      isLive ? "running" : active.conclusion === "success" ? "done" : "error"
    }">${isLive ? "running" : active.conclusion}</span>`;
    liveActive = isLive;
    liveStartedAt = active.created_at;
    $("liveMeta").innerHTML =
      `<span>${steps.filter((s) => s.conclusion === "success").length}/${steps.length} steps</span>` +
      `<span>· <span id="liveElapsed">${fmtElapsed(
        active.created_at,
        active.status === "completed" ? active.updated_at : null
      )}</span></span>`;
    $("liveLink").href = active.html_url;

    const strip = $("liveStrip");
    strip.classList.toggle("hide", !isLive);
    if (isLive) {
      const cur = steps.find((x) => x.status === "in_progress");
      $("lsText").textContent = cur ? cur.name : active.status === "queued" ? "Queue me hai…" : "Shuru ho raha hai…";
      $("lsTime").textContent = fmtElapsed(active.created_at);
    }

    let goalHtml = "";
    let logBody = "";
    if (issueNum) {
      trackedIssue = issueNum;
      try {
        const iss = await gh(`${repoPath()}/issues/${issueNum}`);
        if (iss?.body) goalHtml = `<div class="live-goal">${esc(iss.body.slice(0, 500))}</div>`;
      } catch {}
      try {
        const cs = await gh(`${repoPath()}/issues/${issueNum}/comments?per_page=100`);
        logBody = cs?.length ? cs.at(-1).body || "" : "";
      } catch {}
    }

    const abhi = (logBody.match(/\*\*Abhi:\*\*\s*(.+)/) || [])[1] || "";
    const narration = abhi
      ? `<div class="narration"><span class="n-ico">◐</span><div><b>Abhi:</b> ${esc(abhi.slice(0, 200))}</div></div>`
      : "";

    stepsEl.innerHTML =
      narration + goalHtml +
      (steps.length
        ? steps
            .map((s) => {
              const dur = s.started_at && s.completed_at ? fmtElapsed(s.started_at, s.completed_at) : s.status === "in_progress" ? "…" : "";
              return `<div class="step-row ${stepCls(s)}"><span class="ico">${stepIcon(s)}</span><span class="step-name">${esc(
                s.name
              )}</span><span class="step-dur">${dur}</span></div>`;
            })
            .join("")
        : `<p class="hint">Steps load ho rahe hain…</p>`);

    renderLiveLog(logEl, logBody);

    if (isLive) {
      requestAnimationFrame(() => {
        stepsEl.querySelector(".step-row.active")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        logEl.scrollTop = logEl.scrollHeight;
      });
    }
  } catch (err) {
    stepsEl.innerHTML = `<p class="hint" style="color:var(--danger)">${esc(err.message)}</p>`;
  }
}

/* ══════════════════════ TASKS / FILES ══════════════════════ */
const statusOf = (issue) => {
  const l = (issue.labels || []).map((x) => x.name);
  if (l.includes("agent-failed")) return { cls: "error", text: t("failed") };
  if (l.includes("agent-done")) return { cls: "done", text: t("done") };
  if (l.includes("agent-running")) return { cls: "running", text: t("running") };
  return { cls: "running", text: t("queued") };
};

const TAB_LABEL_KEY = { Live: "live", Tasks: "tasks", Files: "files", Setup: "setup" };

let allIssues = [];
let taskFilter = "all";
let taskQuery = "";

async function loadTasks() {
  if (!configured()) return;
  const el = $("taskList");
  try {
    const issues = await gh(`${repoPath()}/issues?labels=agent-task&state=all&per_page=60&sort=created&direction=desc`);
    allIssues = issues || [];
    renderTaskPage();
  } catch (err) {
    el.innerHTML = `<p class="hint" style="color:var(--danger)">${esc(err.message)}</p>`;
  }
}

function taskBucket(issue) {
  const st = statusOf(issue);
  if (st.cls === "error") return "failed";
  if (st.text === "done" || st.text === "closed") return "done";
  return "running";
}

function renderTaskPage() {
  const el = $("taskList");
  if (!el) return;

  const counts = { all: allIssues.length, running: 0, done: 0, failed: 0 };
  for (const i of allIssues) counts[taskBucket(i)]++;
  if ($("cAll")) $("cAll").textContent = counts.all;
  if ($("cRun")) $("cRun").textContent = counts.running;
  if ($("cDone")) $("cDone").textContent = counts.done;
  if ($("cFail")) $("cFail").textContent = counts.failed;

  const q = taskQuery.toLowerCase();
  const list = allIssues.filter((i) => {
    if (taskFilter !== "all" && taskBucket(i) !== taskFilter) return false;
    if (q && !`${i.title} ${i.number}`.toLowerCase().includes(q)) return false;
    return true;
  });

  if (!list.length) {
    el.innerHTML = `<div class="empty-small"><span class="es-ico" data-icon="tasks"></span>
      <p>${allIssues.length ? "Is filter me kuch nahi mila." : "Abhi koi task nahi — neeche likh kar shuru karein."}</p></div>`;
    hydrateIcons(el);
    return;
  }

  el.innerHTML = list
    .map((i) => {
      const st = statusOf(i);
      const mins = Math.round((Date.now() - new Date(i.created_at).getTime()) / 60000);
      const ago = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
      const dot = st.cls === "error" ? "bad" : st.text === "done" || st.text === "closed" ? "ok" : "busy";
      return `<div class="task-card" data-open="${i.number}">
        <span class="tc-dot ${dot}"></span>
        <div class="tc-body">
          <div class="tc-title">${esc(i.title)}</div>
          <div class="tc-meta"><span>#${i.number}</span><span>${ago} pehle</span><span class="tc-state">${esc(st.text)}</span></div>
        </div>
        <span class="tc-go">›</span>
      </div>`;
    })
    .join("");

  el.querySelectorAll("[data-open]").forEach((c) =>
    c.addEventListener("click", () => focusIssue(Number(c.dataset.open)))
  );
}

on("taskSearch", "input", (e) => {
  taskQuery = e.target.value.trim();
  renderTaskPage();
});

document.querySelectorAll("#taskFilters .fchip").forEach((b) =>
  b.addEventListener("click", () => {
    taskFilter = b.dataset.filter;
    document.querySelectorAll("#taskFilters .fchip").forEach((x) => x.classList.toggle("active", x === b));
    renderTaskPage();
  })
);

async function loadFiles() {
  if (!configured()) return;
  const el = $("fileList");
  try {
    const items = await gh(`${repoPath()}/contents/outputs?ref=${encodeURIComponent(cfg.branch)}`);
    const files = (Array.isArray(items) ? items : []).filter((f) => f.type === "file" && f.name !== ".gitkeep");
    if (!files.length) {
      el.innerHTML = `<p class="hint">Abhi koi file nahi bani.</p>`;
      return;
    }
    el.innerHTML = files
      .sort((a, b) => (a.name < b.name ? 1 : -1))
      .slice(0, 40)
      .map((f) => {
        const isImg = /\.(jpe?g|png|webp|gif)$/i.test(f.name);
        return `<div class="card"><div class="title">${esc(f.name)}</div>
        <div class="meta"><span>${(f.size / 1024).toFixed(1)} KB</span></div>
        ${isImg ? `<img class="file-thumb" src="${f.download_url}" alt="${esc(f.name)}" loading="lazy" onerror="this.style.display='none'" />` : ""}
        <div class="actions"><a class="btn tiny" href="${f.download_url}" target="_blank" rel="noopener" download>Download</a></div></div>`;
      })
      .join("");
  } catch (err) {
    el.innerHTML = `<p class="hint" style="color:var(--danger)">${esc(err.message)}</p>`;
  }
}

/* ══════════════════════ TABS / SETUP ══════════════════════ */
const TABS = ["live", "tasks", "files", "setup"];
const TAB_LABEL = { live: "Live", tasks: "Tasks", files: "Files", setup: "Setup" };

function switchTab(name, manual = false) {
  if (manual) lastManualTabAt = Date.now();
  TABS.forEach((k) => $("tab-" + k)?.classList.toggle("hide", k !== name));
  document.querySelectorAll("[data-nav]").forEach((b) => b.classList.toggle("active", b.dataset.nav === name));
  const titleEl = $("sideTitle");
  if (titleEl) titleEl.textContent = t(name);
}

/** Menu se panel ka section kholo (mobile pe panel bhi khule) */
function navTo(name) {
  switchTab(name, true);
  document.body.classList.add("show-panel");
  document.body.classList.add("page-mode");
  const b = $("panelBtn");
  if (b) b.textContent = "▦";
  closeMenu();
  if (name === "live") loadLive();
  if (name === "tasks") loadTasks();
  if (name === "files") loadFiles();
  
}

document.querySelectorAll("[data-nav]").forEach((btn) =>
  btn.addEventListener("click", () => navTo(btn.dataset.nav))
);



on("runNow", "click", async () => {
  closeMenu();
  if (!configured()) return openSetup();
  try {
    await dispatchWorkflow("");
    toast("✓ Scheduled task trigger ho gaya — Live tab me progress dekhein");
  } catch (err) {
    toast(`✗ ${err.message}`, true);
  }
});

on("goSetup", "click", () => openSetup());
on("cfgBtn", "click", () => openSetup());
on("lsOpen", "click", () => {
  switchTab("live", true);
  loadLive();
});

on("panelBtn", "click", () => {
  const open = document.body.classList.toggle("show-panel");
  const b = $("panelBtn");
  if (b) b.textContent = open ? "▦" : "▤";
});

on("langBtn", "click", () => {
  setLang(window.NETRA_I18N.lang === "en" ? "hi" : "en");
});

document.addEventListener("netra:lang", () => {
  if (!currentThread) showNewTask();
  else if ($("threadTitle") && currentThread) $("threadTitle").textContent = `#${currentThread}`;
  const map = { "tab-live": "live", "tab-tasks": "tasks", "tab-files": "files", "tab-setup": "setup" };
  for (const [id, key] of Object.entries(map)) {
    if ($(id) && !$(id).classList.contains("hide") && $("sideTitle")) $("sideTitle").textContent = t(key);
  }
  renderTaskPage();
  hydrateIcons();
});

on("themeBtn", "click", () => {
  const cur = document.documentElement.getAttribute("data-theme");
  applyTheme(cur === "dark" ? "light" : "dark");
});

function setConfigUI() {
  $("repoPill").textContent = cfg.owner ? `${cfg.owner}/${cfg.repo}` : "not configured";
  $("cfgWarn").classList.toggle("hide", configured());
  $("setupBanner").classList.toggle("hide", configured());
  $("fOwner").value = cfg.owner;
  $("fRepo").value = cfg.repo;
  $("fBranch").value = cfg.branch;
}

function showSetupMsg(kind, text) {
  const el = $("setupMsg");
  el.className = `settings-msg ${kind}`;
  el.textContent = text;
  el.classList.remove("hide");
}

on("setupForm", "submit", async (e) => {
  e.preventDefault();
  cfg.owner = $("fOwner").value.trim() || cfg.owner;
  cfg.repo = $("fRepo").value.trim() || cfg.repo;
  cfg.branch = $("fBranch").value.trim() || "main";
  const tok = $("fToken").value.trim();
  if (tok) cfg.token = tok;

  localStorage.setItem(LS.owner, cfg.owner);
  localStorage.setItem(LS.repo, cfg.repo);
  localStorage.setItem(LS.branch, cfg.branch);
  localStorage.setItem(LS.token, cfg.token);
  if (!configured()) return showSetupMsg("err", "Owner, repo aur token teeno chahiye.");

  try {
    const r = await gh(repoPath());
    showSetupMsg("ok", `✓ Connected: ${r.full_name} · ${r.private ? "PRIVATE (cron nahi chalega — public karein)" : "public ✓"}`);
    setConfigUI();
    loadLive();
    loadSetup();
    loadModelState();
    loadTasks();
    loadFiles();
    loadThreads();
  } catch (err) {
    showSetupMsg("err", `✗ ${err.message} — token ki permissions check karein.`);
  }
});

/* ══════════════════════ SETUP (connection + keys + model + limits) ══════════════════════ */
const SECRET_FOR = {
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  dahl: "DAHL_API_KEY",
};
const BASE_FOR = {
  groq: "https://api.groq.com/openai/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  dahl: "https://inference.dahl.global/v1",
};
const MODEL_LIST = {
  gemini: ["gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-flash-latest"],
  groq: ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b", "allam-2-7b"],
  nvidia: ["meta/llama-3.3-70b-instruct", "nvidia/llama-3.3-nemotron-super-49b-v1", "qwen/qwen2.5-72b-instruct", "deepseek-ai/deepseek-r1"],
  dahl: ["MiniMaxAI/MiniMax-M2.7", "deepseek-ai/DeepSeek-V4-Flash-0731", "zai-org/GLM-5.3-Flash"],
  openrouter: [
    "minimax/minimax-m3.1-flash:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "nvidia/nemotron-3.5-super-vl:free",
    "google/gemma-4-31b-it:free",
    "thinkingmachines/inkling:free",
    "openrouter/free",
  ],
};

let secretsCache = [];
let varsCache = {};

function msg(elId, kind, text) {
  const el = $(elId);
  if (!el) return;
  el.className = `settings-msg ${kind}`;
  el.textContent = text;
  el.classList.remove("hide");
}

async function sodiumLib() {
  const s = window.sodium;
  if (!s) throw new Error("Encryption library load nahi hui — page reload karein");
  await s.ready;
  return s;
}

async function setSecret(name, value) {
  const s = await sodiumLib();
  const pk = await gh(`${repoPath()}/actions/secrets/public-key`);
  const binKey = s.from_base64(pk.key, s.base64_variants.ORIGINAL);
  const sealed = s.crypto_box_seal(s.from_string(value), binKey);
  return gh(`${repoPath()}/actions/secrets/${name}`, {
    method: "PUT",
    body: JSON.stringify({
      encrypted_value: s.to_base64(sealed, s.base64_variants.ORIGINAL),
      key_id: pk.key_id,
    }),
  });
}

async function setVariable(name, value) {
  try {
    return await gh(`${repoPath()}/actions/variables/${name}`, {
      method: "PATCH",
      body: JSON.stringify({ name, value }),
    });
  } catch {
    return gh(`${repoPath()}/actions/variables`, { method: "POST", body: JSON.stringify({ name, value }) });
  }
}

function providerFromVars() {
  const isOpenAI = (varsCache.LLM_PROVIDER || "gemini") === "openai";
  if (!isOpenAI) return "gemini";
  const base = varsCache.LLM_BASE_URL || "";
  if (/dahl\.global/.test(base)) return "dahl";
  if (/openrouter\.ai/.test(base)) return "openrouter";
  if (/nvidia/.test(base)) return "nvidia";
  if (/groq\.com/.test(base)) return "groq";
  return "groq";
}

async function loadSetup() {
  if (!configured()) {
    const el = $("pipeList");
    if (el) el.innerHTML = `<p class="hint">Pehle step 1 me repo + token daalein.</p>`;
    return;
  }

  try {
    const v = await gh(`${repoPath()}/actions/variables`);
    varsCache = {};
    for (const x of v.variables || []) varsCache[x.name] = x.value;
  } catch {}

  try {
    const sc = await gh(`${repoPath()}/actions/secrets`);
    secretsCache = (sc.secrets || []).map((x) => x.name);
  } catch {
    secretsCache = [];
  }

  // key chips
  for (const [prov, secret] of Object.entries(SECRET_FOR)) {
    const chip = $(`chip-${prov}`);
    if (!chip) continue;
    const has = secretsCache.includes(secret);
    chip.textContent = has ? "✓ saved" : "not set";
    chip.className = `chip ${has ? "ok" : ""}`;
  }

  // active provider + model
  const prov = providerFromVars();
  if ($("activeProv")) $("activeProv").value = prov;
  renderModelOptions(prov);
  const curModel = prov === "gemini" ? varsCache.GEMINI_MODEL || "gemini-flash-lite-latest" : varsCache.LLM_MODEL || "";
  if ($("activeModel") && curModel) {
    if (![...$("activeModel").options].some((o) => o.value === curModel)) {
      $("activeModel").add(new Option(curModel, curModel));
    }
    $("activeModel").value = curModel;
  }

  // limits
  if ($("vSteps")) $("vSteps").value = varsCache.MAX_STEPS || 20;
  if ($("vPhases")) $("vPhases").value = varsCache.MAX_PHASES || 6;
  if ($("vAcc")) $("vAcc").value = varsCache.ACCURACY_TARGET || 90;

  // status
  const rows = [];
  try {
    const r = await gh(repoPath());
    rows.push({ ok: true, html: `Repo <b>${esc(r.full_name)}</b> — ${r.private ? "⚠ private (cron nahi chalega)" : "public ✓"}` });
  } catch (e) {
    rows.push({ ok: false, html: `Repo access ✗ — ${esc(e.message)}` });
  }
  try {
    const p = await gh(`${repoPath()}/pages`);
    rows.push({ ok: p.status === "built", html: `Dashboard — ${esc(p.status)} · <a href="${p.html_url}" target="_blank" rel="noopener">kholo</a>` });
  } catch {
    rows.push({ ok: false, html: "Pages enabled nahi hai" });
  }
  const keyCount = Object.values(SECRET_FOR).filter((n) => secretsCache.includes(n)).length;
  rows.push({ ok: keyCount > 0, html: `Keys set: <b>${keyCount}</b>/3` });
  rows.push({
    ok: true,
    html: `Active model: <b>${esc(prov)}</b> · <code>${esc(curModel || "—")}</code>`,
  });
  const el = $("pipeList");
  if (el)
    el.innerHTML = rows
      .map((r) => `<div class="pipe-item ${r.ok ? "ok" : "bad"}"><span class="pi-ico">${r.ok ? "✓" : "✗"}</span><span>${r.html}</span></div>`)
      .join("");
}

function renderModelOptions(prov) {
  const sel = $("activeModel");
  if (!sel) return;
  if (prov === "custom") {
    sel.innerHTML = `<option value="">(custom — niche model likhein)</option>`;
    return;
  }
  sel.innerHTML = (MODEL_LIST[prov] || []).map((m) => `<option value="${m}">${m}</option>`).join("");
}

on("activeProv", "change", () => {
  const v = $("activeProv").value;
  $("customBox")?.classList.toggle("hide", v !== "custom");
  renderModelOptions(v);
});

document.querySelectorAll("[data-save]").forEach((btn) =>
  btn.addEventListener("click", async () => {
    const prov = btn.dataset.save;
    const input = $(`key-${prov}`);
    const val = input?.value.trim();
    if (!val) return msg("keysMsg", "err", "Pehle key paste karein.");
    btn.disabled = true;
    msg("keysMsg", "ok", `${prov} key save ho rahi hai…`);
    try {
      await setSecret(SECRET_FOR[prov], val);
      input.value = "";
      msg("keysMsg", "ok", `✓ ${prov} key saved. Ab step 3 se model chunein.`);
      loadSetup();
    } catch (e) {
      msg("keysMsg", "err", `✗ ${e.message}`);
    } finally {
      btn.disabled = false;
    }
  })
);

on("testKeys", "click", async () => {
  const tests = [];
  const g = $("key-gemini")?.value.trim();
  if (g) tests.push(["gemini", g, "https://generativelanguage.googleapis.com/v1beta/models"]);
  const gr = $("key-groq")?.value.trim();
  if (gr) tests.push(["groq", gr, "https://api.groq.com/openai/v1/models"]);
  const nv = $("key-nvidia")?.value.trim();
  if (nv) tests.push(["nvidia", nv, "https://integrate.api.nvidia.com/v1/models"]);
  const dk = $("key-dahl")?.value.trim();
  if (dk) tests.push(["dahl", dk, "https://inference.dahl.global/v1/models"]);
  const ork = $("key-openrouter")?.value.trim();
  if (ork) tests.push(["openrouter", ork, "https://openrouter.ai/api/v1/models"]);
  if (!tests.length) return msg("keysMsg", "err", "Test karne ke liye box me key paste karein.");

  msg("keysMsg", "ok", "Test ho raha hai…");
  const out = [];
  for (const [name, key, url] of tests) {
    try {
      const sep = url.includes("generativelanguage") ? "?key=" : "";
      const r = await fetch(url + sep + encodeURIComponent(key), {
        headers: url.includes("generativelanguage") ? {} : { Authorization: `Bearer ${key}` },
      });
      out.push(`${name}: ${r.ok ? "✓ valid" : "✗ " + r.status}`);
    } catch {
      out.push(`${name}: ✗ network`);
    }
  }
  msg("keysMsg", out.every((x) => x.includes("✓")) ? "ok" : "err", out.join(" · "));
});

on("applyModel", "click", async () => {
  const prov = $("activeProv").value;
  if (prov === "custom") {
    const base = $("customBase").value.trim();
    const model = $("customModel").value.trim();
    if (!base || !model) return msg("modelMsg", "err", "Custom ke liye base URL aur model dono chahiye.");
    msg("modelMsg", "ok", "Apply ho raha hai…");
    try {
      await setVariable("LLM_PROVIDER", "openai");
      await setVariable("LLM_BASE_URL", base);
      await setVariable("LLM_MODEL", model);
      msg("modelMsg", "ok", `✓ Custom provider set: ${model}`);
      loadSetup();
    } catch (e) {
      msg("modelMsg", "err", `✗ ${e.message}`);
    }
    return;
  }
  const model = $("activeModel").value;
  msg("modelMsg", "ok", "Apply ho raha hai…");
  try {
    if (prov === "gemini") {
      await setVariable("LLM_PROVIDER", "gemini");
      await setVariable("GEMINI_MODEL", model);
    } else {
      await setVariable("LLM_PROVIDER", "openai");
      await setVariable("LLM_BASE_URL", BASE_FOR[prov]);
      await setVariable("LLM_MODEL", model);
    }
    msg("modelMsg", "ok", `✓ Ab agent ${prov} · ${model} pe chalega.`);
    loadSetup();
    loadModelState();
  } catch (e) {
    msg("modelMsg", "err", `✗ ${e.message}`);
  }
});

on("saveLimits", "click", async () => {
  msg("limitsMsg", "ok", "Save ho raha hai…");
  try {
    await setVariable("MAX_STEPS", String($("vSteps").value || 20));
    await setVariable("MAX_PHASES", String($("vPhases").value || 6));
    await setVariable("ACCURACY_TARGET", String($("vAcc").value || 90));
    msg("limitsMsg", "ok", "✓ Limits saved.");
    loadSetup();
  } catch (e) {
    msg("limitsMsg", "err", `✗ ${e.message}`);
  }
});

on("pipeRefresh", "click", loadSetup);

/* ══════════════════════ 1-SECOND LIVE ══════════════════════ */
function tickSecond() {
  if (!liveActive) return;
  if (++shotTick % 2 === 0) refreshLiveShot();
  if (!liveStartedAt) return;
  const elapsedTxt = fmtElapsed(liveStartedAt);
  const a = $("lsTime");
  if (a) a.textContent = elapsedTxt;
  const b = $("liveElapsed");
  if (b) b.textContent = elapsedTxt;
}

/** Sirf 1 halka request — progress comment. Isliye har second chal sakta hai. */
let fastPolling = false;
async function fastPoll() {
  if (!configured() || document.hidden || !trackedIssue || fastPolling) return;
  if (rateRemaining < 300) return; // API limit bachao
  fastPolling = true;
  try {
    const cs = await gh(`${repoPath()}/issues/${trackedIssue}/comments?per_page=1&sort=created&direction=desc`);
    const body = cs?.[0]?.body || "";
    if (body && currentThread === trackedIssue) {
      const ui = issueUIs.get(trackedIssue);
      if (ui && !ui.badge?.classList.contains("done") && !ui.badge?.classList.contains("error")) {
        ui.bubble.innerHTML = mdToHtml(body);
        scrollChat();
      }
      if (issueUIs.get(trackedIssue)?.badge?.classList.contains("done")) return;
      const logEl = $("liveLog");
      if (logEl) renderLiveLog(logEl, body);
    }
  } catch {}
  fastPolling = false;
}

on("liveShot", "error", () => $("shotWrap")?.classList.add("hide"));
on("liveShot", "click", () => {
  const u = shotUrl || $("liveShot")?.src;
  if (u) window.open(u, "_blank", "noopener");
});

/* ══════════════════════ BOOT ══════════════════════ */
autoDetect();
I18N.applyI18n();
setConfigUI();
if (configured()) {
  showNewTask();
  loadLive();
  loadSetup();
  loadModelState();
  loadTasks();
  loadFiles();
  setInterval(tickSecond, 1000);      // har second timer update (0 API calls)
  setInterval(fastPoll, 1200);        // har ~1.2s progress comment
  setInterval(() => {
    if (!document.hidden) {
      loadLive();
      loadTasks();
    }
  }, 5000);                            // steps / runs har 5s
}
