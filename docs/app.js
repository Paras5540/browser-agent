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

/* ══════════════════════ CHAT ══════════════════════ */
const chat = $("chat");
const issueUIs = new Map();   // issue# → chat bubble
let trackedIssue = null;      // jis issue ko har second poll karna hai
let replyTo = null;           // follow-up kis issue pe ja raha hai
const issueResults = new Map(); // issue# → last result text

/* live timing (1-second ticker ke liye) */
let liveActive = false;
let liveStartedAt = null;

function scrollChat() {
  chat.scrollTop = chat.scrollHeight;
}

function addUserMsg(text) {
  $("chatEmpty")?.remove();
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
  const fu = n ? `<button class="btn tiny ghost fu" data-followup="${n}" title="Isi task me aage kaam karein">↩ Follow-up</button>` : "";
  return `<span class="dot-sm"></span>Agent${link}<span class="badge ${badgeCls}" data-badge>${badgeText}</span>${fu}`;
}

function addAgentMsg(issueNumber) {
  $("chatEmpty")?.remove();
  const el = document.createElement("div");
  el.className = "msg agent";
  el.innerHTML = `
    <div class="who">${whoHtml(issueNumber, "running", "running")}</div>
    <div class="bubble running" data-bubble><span class="muted">Queue me daal raha hoon…</span></div>`;
  chat.appendChild(el);
  scrollChat();
  return { root: el, bubble: el.querySelector("[data-bubble]"), badge: el.querySelector("[data-badge]") };
}

/** Issue ko poll karta hai aur result seedha chat bubble me likhta hai. */
async function watchIssue(n, ui) {
  const started = Date.now();
  while (Date.now() - started < 50 * 60 * 1000) {
    let iss, cs;
    try {
      iss = await gh(`${repoPath()}/issues/${n}`);
      cs = await gh(`${repoPath()}/issues/${n}/comments?per_page=100`);
    } catch {
      await sleep(6000);
      continue;
    }
    const labels = (iss.labels || []).map((l) => l.name);
    const body = cs?.length ? cs.at(-1).body || "" : "";
    const finished = labels.includes("agent-done") || labels.includes("agent-failed") || iss.state === "closed";
    if (body) issueResults.set(n, body);

    ui.bubble.innerHTML = body
      ? mdToHtml(body)
      : `<span class="muted">${iss.state === "open" ? "Queue me hai…" : "Koi output nahi"}</span>`;

    if (finished) {
      ui.badge.className = `badge ${labels.includes("agent-failed") ? "error" : "done"}`;
      ui.badge.textContent = labels.includes("agent-failed") ? "failed" : "done";
      ui.bubble.classList.remove("running");
      scrollChat();
      return;
    }
    ui.bubble.classList.add("running");
    scrollChat();
    await sleep(5000);
  }
}

/** Purane tasks ko chat ki tarah render karo (page reload ke baad bhi dikhein). */
async function loadChatHistory() {
  if (!configured()) return;
  try {
    const issues = await gh(`${repoPath()}/issues?labels=agent-task&state=all&per_page=12&sort=created&direction=desc`);
    if (!issues.length) return;
    $("chatEmpty")?.remove();

    for (const iss of [...issues].reverse()) {
      addUserMsg(iss.body || iss.title);
      const ui = addAgentMsg(iss.number);
      const cs = await gh(`${repoPath()}/issues/${iss.number}/comments?per_page=100`);
      const body = cs?.length ? cs.at(-1).body || "" : "";
      const labels = (iss.labels || []).map((l) => l.name);
      issueUIs.set(iss.number, ui);
      if (body) issueResults.set(iss.number, body);
      ui.bubble.innerHTML = body ? mdToHtml(body) : `<span class="muted">Koi output nahi</span>`;
      const done = labels.includes("agent-done");
      const failed = labels.includes("agent-failed");
      if (done || failed || iss.state === "closed") {
        ui.badge.className = `badge ${failed ? "error" : "done"}`;
        ui.badge.textContent = failed ? "failed" : "done";
        ui.bubble.classList.remove("running");
      } else {
        watchIssue(iss.number, ui); // abhi bhi chal raha hai to poll karte raho
      }
    }
    scrollChat();
  } catch (err) {
    console.warn("history:", err.message);
  }
}

/* ── follow-up / reply mode ── */
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

chat.addEventListener("click", (e) => {
  const b = e.target.closest("[data-followup]");
  if (!b) return;
  setReply(Number(b.dataset.followup));
  $("input").placeholder = `#${b.dataset.followup} me aage kaam — naya instruction likhein…`;
});

/** Purana task chat me kholo / us tak scroll karo */
async function focusIssue(n) {
  let ui = issueUIs.get(n);
  if (!ui) {
    // chat history me nahi hai — load karke append karo
    try {
      const iss = await gh(`${repoPath()}/issues/${n}`);
      const cs = await gh(`${repoPath()}/issues/${n}/comments?per_page=100`);
      const body = cs?.length ? cs.at(-1).body || "" : "";
      addUserMsg(iss.body || iss.title);
      ui = addAgentMsg(n);
      const labels = (iss.labels || []).map((l) => l.name);
      const failed = labels.includes("agent-failed");
      ui.root.querySelector(".who").innerHTML = whoHtml(n, failed ? "error" : "done", failed ? "failed" : "done");
      ui.badge = ui.root.querySelector("[data-badge]");
      ui.bubble.innerHTML = body ? mdToHtml(body) : `<span class="muted">Koi output nahi</span>`;
      ui.bubble.classList.remove("running");
      issueUIs.set(n, ui);
      if (body) issueResults.set(n, body);
    } catch (err) {
      return;
    }
  }
  ui.root.scrollIntoView({ behavior: "smooth", block: "start" });
  ui.root.classList.add("highlight");
  setTimeout(() => ui.root.classList.remove("highlight"), 2200);
}

/* ── composer ── */
const form = $("composer");
const input = $("input");

function autoGrow() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 120) + "px";
}
input?.addEventListener("input", autoGrow);

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const goal = input.value.trim();
  if (!goal) return;
  if (!configured()) {
    switchTab("setup");
    showSetupMsg("err", "Pehle Setup tab me repo + token daalein.");
    return;
  }

  input.value = "";
  autoGrow();
  addUserMsg(goal);
  const ui = addAgentMsg(null);

  try {
    let issue;
    if (replyTo) {
      const prev = issueResults.get(replyTo) || "";
      const body =
        `Continuing task #${replyTo} (same website/work).\n\n` +
        (prev ? `Previous result:\n${prev.slice(0, 3000)}\n\n` : "") +
        `New instruction:\n${goal}`;
      issue = await createTask(body, `Follow-up #${replyTo}: ${goal}`);
      setReply(null);
    } else {
      issue = await createTask(goal);
    }
    ui.root.querySelector(".who").innerHTML = whoHtml(issue.number, "running", "queued");
    ui.badge = ui.root.querySelector("[data-badge]");
    issueUIs.set(issue.number, ui);
    trackedIssue = issue.number;
    watchIssue(issue.number, ui);
    loadTasks();
    loadLive();
  } catch (err) {
    ui.bubble.innerHTML = `<span style="color:var(--danger)">✗ ${esc(err.message)}</span>`;
    ui.badge.className = "badge error";
    ui.badge.textContent = "error";
  }
});

input?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) form.requestSubmit();
});

document.querySelectorAll(".sug").forEach((b) =>
  b.addEventListener("click", () => {
    input.value = b.textContent.trim();
    autoGrow();
    input.focus();
  })
);

on("clearChat", "click", () => {
  chat.innerHTML = `<div class="empty" id="chatEmpty"><h3>Chat clear</h3><p>Naya task likhein.</p></div>`;
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
const TABS = ["live", "tasks", "files", "setup"];
function switchTab(name, manual = false) {
  if (manual) lastManualTabAt = Date.now();
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  TABS.forEach((k) => $("tab-" + k).classList.toggle("hide", k !== name));
}

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    switchTab(t.dataset.tab, true);
    if (t.dataset.tab === "live") loadLive();
    if (t.dataset.tab === "tasks") loadTasks();
    if (t.dataset.tab === "files") loadFiles();
  })
);

on("runNow", "click", async () => {
  if (!configured()) return switchTab("setup");
  try {
    await dispatchWorkflow("");
    addAgentMsg(null).bubble.innerHTML = `<span class="muted">Scheduled task trigger ho gaya — Actions tab me progress dekhein.</span>`;
  } catch (err) {
    addAgentMsg(null).bubble.innerHTML = `<span style="color:var(--danger)">✗ ${esc(err.message)}</span>`;
  }
});

on("goSetup", "click", () => switchTab("setup"));
on("cfgBtn", "click", () => switchTab("setup"));
on("lsOpen", "click", () => {
  switchTab("live", true);
  loadLive();
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
    loadTasks();
    loadFiles();
    loadChatHistory();
  } catch (err) {
    showSetupMsg("err", `✗ ${err.message} — token ki permissions check karein.`);
  }
});

/* ══════════════════════ 1-SECOND LIVE ══════════════════════ */
function tickSecond() {
  if (!liveActive || !liveStartedAt) return;
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
    if (body) {
      const ui = issueUIs.get(trackedIssue);
      if (ui && !ui.badge?.classList.contains("done") && !ui.badge?.classList.contains("error")) {
        ui.bubble.innerHTML = mdToHtml(body);
        scrollChat();
      }
      const logEl = $("liveLog");
      if (logEl) renderLiveLog(logEl, body);
    }
  } catch {}
  fastPolling = false;
}

/* ══════════════════════ BOOT ══════════════════════ */
autoDetect();
setConfigUI();
if (configured()) {
  loadChatHistory();
  loadLive();
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
