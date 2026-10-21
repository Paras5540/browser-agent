/* Browser Agent — cloud dashboard (GitHub Pages, no server) */
const LS = { owner: "ba_owner", repo: "ba_repo", branch: "ba_branch", token: "ba_token" };

const cfg = {
  owner: localStorage.getItem(LS.owner) || "",
  repo: localStorage.getItem(LS.repo) || "",
  branch: localStorage.getItem(LS.branch) || "main",
  token: localStorage.getItem(LS.token) || "",
};

const $ = (id) => document.getElementById(id);
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
  if (!t) t = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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
    throw new Error(res.status === 401 ? "Token galat ya expired hai" : msg);
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
  currentThread = null;
  $("threadList").classList.remove("hide");
  $("chat").classList.add("hide");
  $("backBtn").classList.add("hide");
  $("threadTitle").textContent = "Tasks";
  loadThreads();
}

function showThreadView(n, title) {
  currentThread = n;
  $("threadList").classList.add("hide");
  $("chat").classList.remove("hide");
  $("backBtn").classList.remove("hide");
  $("threadTitle").textContent = title || `#${n}`;
}

function scrollChat() {
  chat.scrollTop = chat.scrollHeight;
}

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
function refreshLiveShot() {
  const wrap = $("shotWrap");
  const img = $("liveShot");
  if (!wrap || !img || !cfg.owner) return;
  const url = `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/live/outputs/live/latest.jpg?t=${Date.now()}`;
  if (img.getAttribute("src") !== url) img.src = url;
  $("shotOpen").href = `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/live/outputs/live/latest.jpg`;
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

/* ── panel menu (⋮) ── */
function closeMenu() {
  $("panelMenu")?.classList.add("hide");
  $("menuBtn")?.setAttribute("aria-expanded", "false");
}

function toggleMenu() {
  const btn = $("menuBtn");
  const menu = $("panelMenu");
  if (!btn || !menu) return;
  if (!menu.classList.contains("hide")) return closeMenu();

  menu.classList.remove("hide");
  btn.setAttribute("aria-expanded", "true");

  // fixed positioning — panel ke overflow se clip na ho
  const r = btn.getBoundingClientRect();
  const w = menu.offsetWidth || 200;
  menu.style.top = `${Math.round(r.bottom + 6)}px`;
  menu.style.left = `${Math.round(Math.min(r.right - w, window.innerWidth - w - 10))}px`;
}

on("menuSetup", "click", () => {
  closeMenu();
  openSetup();
});

on("menuBtn", "click", (e) => {
  e.stopPropagation();
  toggleMenu();
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("#panelMenu") && !e.target.closest("#menuBtn")) closeMenu();
});

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
on("backBtn", "click", () => { closeMenu(); showList(); });
on("clearChat", "click", () => {
  closeMenu();
  if (threadVisible()) showList();
  else loadThreads();
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
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 72) + "px";
}
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
  if (l.includes("agent-failed")) return { cls: "error", text: "failed" };
  if (l.includes("agent-done")) return { cls: "done", text: "done" };
  if (l.includes("agent-running")) return { cls: "running", text: "running" };
  return { cls: "running", text: issue.state === "closed" ? "closed" : "queued" };
};

async function loadTasks() {
  if (!configured()) return;
  const el = $("taskList");
  try {
    const issues = await gh(`${repoPath()}/issues?labels=agent-task&state=all&per_page=15&sort=created&direction=desc`);
    if (!issues.length) {
      el.innerHTML = `<p class="hint">Abhi koi task nahi.</p>`;
      return;
    }
    el.innerHTML = issues
      .map((i) => {
        const st = statusOf(i);
        return `<div class="card clickable" data-open="${i.number}">
          <div class="title">${esc(i.title)}<span class="badge ${st.cls}">${st.text}</span></div>
          <div class="meta"><span>#${i.number}</span><span>· ${new Date(i.created_at).toLocaleString()}</span></div>
        </div>`;
      })
      .join("");
    el.querySelectorAll("[data-open]").forEach((c) =>
      c.addEventListener("click", () => focusIssue(Number(c.dataset.open)))
    );
  } catch (err) {
    el.innerHTML = `<p class="hint" style="color:var(--danger)">${esc(err.message)}</p>`;
  }
}

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
      .map(
        (f) => `<div class="card"><div class="title">${esc(f.name)}</div>
        <div class="meta"><span>${(f.size / 1024).toFixed(1)} KB</span></div>
        <div class="actions"><a class="btn tiny" href="${f.download_url}" target="_blank" rel="noopener" download>Download</a></div></div>`
      )
      .join("");
  } catch (err) {
    el.innerHTML = `<p class="hint" style="color:var(--danger)">${esc(err.message)}</p>`;
  }
}

/* ══════════════════════ TABS / SETUP ══════════════════════ */
const TABS = ["live", "tasks", "files", "keys", "setup"];
const TAB_LABEL = { live: "Live", tasks: "Tasks", files: "Files", keys: "Keys", setup: "Setup" };

function switchTab(name, manual = false) {
  if (manual) lastManualTabAt = Date.now();
  TABS.forEach((k) => $("tab-" + k)?.classList.toggle("hide", k !== name));
  document.querySelectorAll("[data-nav]").forEach((b) => b.classList.toggle("active", b.dataset.nav === name));
  const t = $("sideTitle");
  if (t) t.textContent = TAB_LABEL[name] || name;
}

/** Menu se panel ka section kholo (mobile pe panel bhi khule) */
function navTo(name) {
  switchTab(name, true);
  document.body.classList.add("show-panel");
  const b = $("panelBtn");
  if (b) b.textContent = "▦";
  closeMenu();
  if (name === "live") loadLive();
  if (name === "tasks") loadTasks();
  if (name === "files") loadFiles();
  if (name === "keys") loadKeys();
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
    loadKeys();
    loadTasks();
    loadFiles();
    loadThreads();
  } catch (err) {
    showSetupMsg("err", `✗ ${err.message} — token ki permissions check karein.`);
  }
});

/* ══════════════════════ KEYS / PIPELINE ══════════════════════ */
const KEY_NAMES = ["GEMINI_API_KEY", "GEMINI_KEY_2", "GEMINI_KEY_3", "GEMINI_KEY_4"];
const GROQ_BASE = "https://api.groq.com/openai/v1";
const GROQ_DEFAULT_MODEL = "llama-3.3-70b-versatile";
const ZEN_BASE = "https://opencode.ai/zen/v1";
const ZEN_DEFAULT_MODEL = "nemotron-3-ultra-free";

/** provider select badalne pe sensible defaults */
function applyProviderDefaults() {
  const p = $("pProvider")?.value;
  if (!p) return;
  if (p === "groq" || p === "zen" || p === "openai") {
    if (p === "zen") {
      $("pBase").value = ZEN_BASE;
      if (!$("pModel").value || /llama-3\.3/.test($("pModel").value)) $("pModel").value = ZEN_DEFAULT_MODEL;
    } else if (p === "groq") {
      $("pBase").value = GROQ_BASE;
      if (!$("pModel").value || /-free$/.test($("pModel").value)) $("pModel").value = GROQ_DEFAULT_MODEL;
    } else if (!$("pBase").value) {
      $("pBase").value = GROQ_BASE;
      if (!$("pModel").value) $("pModel").value = GROQ_DEFAULT_MODEL;
    }
  } else {
    if ($("pBase").value === GROQ_BASE || !$("pBase").value) $("pBase").value = "";
    if ($("pModel").value === GROQ_DEFAULT_MODEL) $("pModel").value = "";
  }
}

function msg(elId, kind, text) {
  const el = $(elId);
  if (!el) return;
  el.className = `settings-msg ${kind}`;
  el.textContent = text;
  el.classList.remove("hide");
}

async function sodiumLib() {
  const s = window.sodium;
  if (!s) throw new Error("Encryption library load nahi hui — page reload karein / internet check karein");
  await s.ready;
  return s;
}

/** GitHub Actions secret set karta hai (libsodium sealed box). */
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

async function loadKeys() {
  if (!configured()) return;
  const list = $("pipeList");
  const rows = [];
  let secretNames = [];
  let vars = {};

  // 1. repo
  try {
    const r = await gh(repoPath());
    rows.push({ ok: true, html: `Repo <b>${esc(r.full_name)}</b> — ${r.private ? "⚠ private (cron nahi chalega)" : "public ✓"}` });
  } catch (e) {
    rows.push({ ok: false, html: `Repo access ✗ — ${esc(e.message)}` });
  }

  // 2. workflow file
  try {
    await gh(`${repoPath()}/contents/.github/workflows/agent.yml`);
    rows.push({ ok: true, html: "Workflow <b>agent.yml</b> present ✓" });
  } catch {
    rows.push({ ok: false, html: "Workflow file nahi mili" });
  }

  // 3. Pages
  try {
    const p = await gh(`${repoPath()}/pages`);
    rows.push({ ok: p.status === "built", html: `Dashboard Pages — ${esc(p.status)} · <a href="${p.html_url}" target="_blank" rel="noopener">kholo</a>` });
  } catch {
    rows.push({ ok: false, html: "Pages enabled nahi hai" });
  }

  // 4. secrets
  try {
    const s = await gh(`${repoPath()}/actions/secrets`);
    secretNames = (s.secrets || []).map((x) => x.name);
    const gem = KEY_NAMES.filter((n) => secretNames.includes(n));
    rows.push({ ok: gem.length > 0, html: `Keys set: <b>${gem.length}</b>/${KEY_NAMES.length} ${gem.map((g) => g.replace("GEMINI_", "")).join(", ")}` });
  } catch (e) {
    rows.push({ ok: false, html: `Secrets padhne ki permission nahi — token me <b>Secrets: Read and write</b> add karein` });
  }

  // 5. variables
  try {
    const v = await gh(`${repoPath()}/actions/variables`);
    for (const x of v.variables || []) vars[x.name] = x.value;
    rows.push({ ok: Object.keys(vars).length > 0, html: `Variables — model <b>${esc(vars.GEMINI_MODEL || "—")}</b>, steps <b>${esc(vars.MAX_STEPS || "—")}</b>` });

    const prov = vars.LLM_PROVIDER || "gemini";
    const hasLlmKey = secretNames.includes("LLM_API_KEY");
    rows.push({
      ok: prov === "gemini" ? true : hasLlmKey,
      html:
        prov === "gemini"
          ? "Provider: <b>Gemini</b>"
          : `Provider: <b>${esc(prov)}</b> · <code>${esc(vars.LLM_MODEL || "—")}</code> ${hasLlmKey ? "· key ✓" : "· <b style=\"color:var(--danger)\">key missing</b>"}`,
    });

    if ($("pProvider")) {
      const base = vars.LLM_BASE_URL || "";
      $("pProvider").value = prov !== "openai" ? "gemini" : /opencode\.ai/.test(base) ? "zen" : /groq\.com/.test(base) ? "groq" : "openai";
    }
    if ($("pBase") && vars.LLM_BASE_URL) $("pBase").value = vars.LLM_BASE_URL;
    if ($("pModel") && vars.LLM_MODEL) $("pModel").value = vars.LLM_MODEL;
  } catch {
    rows.push({ ok: false, html: "Variables padhne ki permission nahi (Variables: Read)" });
  }

  list.innerHTML = rows
    .map((r) => `<div class="pipe-item ${r.ok ? "ok" : "bad"}"><span class="pi-ico">${r.ok ? "✓" : "✗"}</span><span>${r.html}</span></div>`)
    .join("");

  for (let i = 0; i < 4; i++) {
    const st = $("st" + (i + 1));
    if (!st) continue;
    const has = secretNames.includes(KEY_NAMES[i]);
    st.textContent = has ? "saved" : "—";
    st.className = `key-state ${has ? "ok" : ""}`;
  }

  if ($("pProvider") && !vars.LLM_PROVIDER) $("pProvider").value = "gemini";
  if ($("vModel") && vars.GEMINI_MODEL) $("vModel").value = vars.GEMINI_MODEL;
  if ($("vSteps") && vars.MAX_STEPS) $("vSteps").value = vars.MAX_STEPS;
  if ($("vFallback") && vars.FALLBACK_MODELS) $("vFallback").value = vars.FALLBACK_MODELS;
}

on("pipeRefresh", "click", loadKeys);
on("pProvider", "change", applyProviderDefaults);

on("pBase", "change", () => {
  const v = $("pBase").value.trim();
  if (/opencode\.ai/.test(v)) {
    $("pBase").value = ZEN_BASE;
    if (!$("pModel").value) $("pModel").value = ZEN_DEFAULT_MODEL;
  }
});

on("testProv", "click", async () => {
  const base = ($("pBase")?.value || GROQ_BASE).replace(/\/+$/, "");
  const key = $("pKey")?.value.trim();
  if (!key) return msg("provMsg", "err", "Pehle Groq key paste karein (gsk_…).");
  msg("provMsg", "ok", "Test ho raha hai…");
  try {
    const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) return msg("provMsg", "err", `✗ ${r.status} — key galat ya expired`);
    const j = await r.json();
    const names = (j.data || []).map((m) => m.id).filter((n) => !/whisper|tts|guard/i.test(n)).slice(0, 8);
    msg("provMsg", "ok", `✓ Key valid · models: ${names.join(", ")}`);
  } catch (e) {
    msg("provMsg", "err", `✗ Network error: ${e.message}`);
  }
});

on("provForm", "submit", async (e) => {
  e.preventDefault();
  const provSel = $("pProvider").value;
  const prov = provSel === "gemini" ? "gemini" : "openai";
  const base = prov === "openai" ? ($("pBase")?.value.trim() || GROQ_BASE) : "";
  const model = $("pModel")?.value.trim() || (prov === "openai" ? GROQ_DEFAULT_MODEL : "");
  const key = $("pKey")?.value.trim();

  msg("provMsg", "ok", "Save ho raha hai…");
  try {
    await setVariable("LLM_PROVIDER", prov);
    if (prov === "openai") {
      await setVariable("LLM_BASE_URL", base);
      await setVariable("LLM_MODEL", model);
      if (key) {
        await setSecret("LLM_API_KEY", key);
        $("pKey").value = "";
      }
    }
    msg("provMsg", "ok", `✓ Provider: ${prov}${prov === "openai" ? ` · ${model}` : ""}. Agla task isi se chalega.`);
    loadKeys();
  } catch (err) {
    msg("provMsg", "err", `✗ ${err.message} — token me Secrets/Variables write permission chahiye`);
  }
});

on("testKeys", "click", async () => {
  const vals = [1, 2, 3, 4].map((i) => $(`k${i}`)?.value.trim() || "").filter(Boolean);
  if (!vals.length) return msg("keysMsg", "err", "Pehle key paste karein (jo box me hai wahi test hoga).");
  msg("keysMsg", "ok", "Test ho raha hai…");

  const out = [];
  for (let i = 0; i < vals.length; i++) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(vals[i])}`);
      out.push(`key ${i + 1}: ${r.ok ? "✓ valid" : "✗ " + r.status}`);
    } catch (e) {
      out.push(`key ${i + 1}: ✗ network`);
    }
  }
  msg("keysMsg", out.every((x) => x.includes("✓")) ? "ok" : "err", out.join(" · "));
});

on("keysForm", "submit", async (e) => {
  e.preventDefault();
  const vals = [1, 2, 3, 4].map((i) => $(`k${i}`)?.value.trim() || "");
  const todo = KEY_NAMES.map((n, i) => [n, vals[i]]).filter(([, v]) => v);

  if (!todo.length) return msg("keysMsg", "err", "Koi key nahi daali.");
  msg("keysMsg", "ok", "GitHub Secrets me save ho raha hai…");

  const done = [];
  for (const [name, value] of todo) {
    try {
      await setSecret(name, value);
      done.push(name);
      $(`k${KEY_NAMES.indexOf(name) + 1}`).value = "";
    } catch (err) {
      return msg("keysMsg", "err", `✗ ${name}: ${err.message} — token me Secrets: Read and write permission chahiye`);
    }
  }
  msg("keysMsg", "ok", `✓ Saved: ${done.join(", ")}. Agla task in keys ko use karega.`);
  loadKeys();
});

on("varsForm", "submit", async (e) => {
  e.preventDefault();
  const payload = [];
  const m = $("vModel")?.value;
  const st = $("vSteps")?.value;
  const fb = $("vFallback")?.value.trim();
  if (m) payload.push(["GEMINI_MODEL", m]);
  if (st) payload.push(["MAX_STEPS", String(st)]);
  if (fb) payload.push(["FALLBACK_MODELS", fb]);

  msg("varsMsg", "ok", "Save ho raha hai…");
  try {
    for (const [k, v] of payload) await setVariable(k, v);
    msg("varsMsg", "ok", `✓ Saved: ${payload.map((p) => p[0]).join(", ")}`);
    loadKeys();
  } catch (err) {
    msg("varsMsg", "err", `✗ ${err.message} — token me Variables: Read and write chahiye`);
  }
});

/* ══════════════════════ 1-SECOND LIVE ══════════════════════ */
function tickSecond() {
  if (!liveActive) return;
  if (++shotTick % 2 === 0) refreshLiveShot();
  if (!liveStartedAt) return;
  const t = fmtElapsed(liveStartedAt);
  const a = $("lsTime");
  if (a) a.textContent = t;
  const b = $("liveElapsed");
  if (b) b.textContent = t;
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
  const u = $("liveShot")?.src;
  if (u) window.open(u, "_blank", "noopener");
});

/* ══════════════════════ BOOT ══════════════════════ */
autoDetect();
setConfigUI();
if (configured()) {
  loadThreads();
  loadLive();
  loadKeys();
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
