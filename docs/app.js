/* Browser Agent — cloud dashboard (GitHub Pages, no server) */
const LS = {
  owner: "ba_owner",
  repo: "ba_repo",
  branch: "ba_branch",
  token: "ba_token",
};

const cfg = {
  owner: localStorage.getItem(LS.owner) || "",
  repo: localStorage.getItem(LS.repo) || "",
  branch: localStorage.getItem(LS.branch) || "main",
  token: localStorage.getItem(LS.token) || "",
};

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const configured = () => cfg.owner && cfg.repo && cfg.token;

// ── auto-detect repo from github.io URL ──────────────────────────────────────
function autoDetect() {
  const host = location.hostname;
  if (!host.endsWith("github.io")) return;
  const user = host.split(".")[0];
  const path = location.pathname.split("/").filter(Boolean);
  const repo = path.length ? path[0] : `${user}.github.io`;
  if (!cfg.owner) cfg.owner = user;
  if (!cfg.repo) cfg.repo = repo;
}

// ── GitHub API ───────────────────────────────────────────────────────────────
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
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.message || `HTTP ${res.status}`;
    throw new Error(res.status === 401 ? "Token galat ya expired hai" : msg);
  }
  return json;
}

const repoPath = () => `/repos/${cfg.owner}/${cfg.repo}`;

async function ensureLabel(name, color = "1d76db") {
  try {
    await gh(`${repoPath()}/labels/${encodeURIComponent(name)}`);
  } catch {
    try {
      await gh(`${repoPath()}/labels`, {
        method: "POST",
        body: JSON.stringify({ name, color }),
      });
    } catch {}
  }
}

// ── task creation ────────────────────────────────────────────────────────────
async function createTask(goal) {
  await ensureLabel("agent-task");
  await ensureLabel("agent-running", "fbca04");
  await ensureLabel("agent-done", "0e8a16");
  await ensureLabel("agent-failed", "d73a4a");

  const title = goal.split("\n")[0].slice(0, 72) || "agent task";
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

// ── rendering ────────────────────────────────────────────────────────────────
function setConfigUI() {
  $("repoPill").textContent = cfg.owner ? `${cfg.owner}/${cfg.repo}` : "not configured";
  $("cfgWarn").classList.toggle("hide", configured());
  $("setupBanner").classList.toggle("hide", configured());
  $("fOwner").value = cfg.owner;
  $("fRepo").value = cfg.repo;
  $("fBranch").value = cfg.branch;
}

function statusOf(issue) {
  const labels = (issue.labels || []).map((l) => l.name);
  if (labels.includes("agent-running")) return { cls: "running", text: "running" };
  if (labels.includes("agent-done")) return { cls: "done", text: "done" };
  if (labels.includes("agent-failed")) return { cls: "error", text: "failed" };
  if (issue.state === "closed") return { cls: "done", text: "closed" };
  return { cls: "running", text: "queued" };
}

async function loadTasks() {
  if (!configured()) return;
  const el = $("taskList");
  try {
    const issues = await gh(
      `${repoPath()}/issues?labels=agent-task&state=all&per_page=15&sort=created&direction=desc`
    );
    if (!issues.length) {
      el.innerHTML = `<p class="hint">Koi task nahi. Upar se pehla task likhein.</p>`;
      return;
    }

    const cards = await Promise.all(
      issues.map(async (i) => {
        const st = statusOf(i);
        let result = "";
        if (st.cls !== "queued") {
          try {
            const cs = await gh(`${repoPath()}/issues/${i.number}/comments?per_page=100`);
            if (cs?.length) result = cs[cs.length - 1].body || "";
          } catch {}
        }
        return `
        <div class="card">
          <div class="title">${esc(i.title)}<span class="badge ${st.cls}">${st.text}</span></div>
          <div class="meta">
            <span>#${i.number}</span>
            <span>· ${new Date(i.created_at).toLocaleString()}</span>
          </div>
          ${result ? `<pre>${esc(result.replace(/^#+\s*/gm, "").slice(0, 1200))}</pre>` : ""}
          <div class="actions">
            <a class="btn tiny" href="${i.html_url}" target="_blank" rel="noopener">Issue</a>
          </div>
        </div>`;
      })
    );
    el.innerHTML = cards.join("");
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
        (f) => `
        <div class="card">
          <div class="title">${esc(f.name)}</div>
          <div class="meta"><span>${(f.size / 1024).toFixed(1)} KB</span></div>
          <div class="actions"><a class="btn tiny" href="${f.download_url}" target="_blank" rel="noopener" download>Download</a></div>
        </div>`
      )
      .join("");
  } catch (err) {
    el.innerHTML = `<p class="hint" style="color:var(--danger)">${esc(err.message)}</p>`;
  }
}

// ── chat ─────────────────────────────────────────────────────────────────────
const chat = $("chat");

function addMsg(role, text, cls = "") {
  $("chatEmpty")?.remove();
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.innerHTML = `<div class="who">${role === "user" ? "You" : "Agent"}</div>
    <div class="bubble ${cls}">${esc(text)}</div>`;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const goal = $("input").value.trim();
  if (!goal) return;

  if (!configured()) {
    switchTab("setup");
    showSetupMsg("err", "Pehle Setup tab me repo + token daalein.");
    return;
  }

  $("input").value = "";
  addMsg("user", goal);
  const pending = addMsg("agent", "Task queue me daala ja raha hai…");

  try {
    const issue = await createTask(goal);
    pending.querySelector(".bubble").innerHTML =
      `✓ Task queue me hai — <a href="${issue.html_url}" target="_blank" rel="noopener" style="color:var(--accent)">issue #${issue.number}</a><br>` +
      `<span style="color:var(--muted);font-size:12px">Agent 1-2 minute me shuru hoga (Actions queue). Result yahan aur Tasks tab me aayega.</span>`;
    loadTasks();
  } catch (err) {
    pending.querySelector(".bubble").innerHTML = `<span style="color:var(--danger)">✗ ${esc(err.message)}</span>`;
  }
});

$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("composer").requestSubmit();
});

document.querySelectorAll(".sug").forEach((b) =>
  b.addEventListener("click", () => {
    $("input").value = b.textContent.trim();
    $("input").focus();
  })
);

$("runNow").addEventListener("click", async () => {
  if (!configured()) return switchTab("setup");
  try {
    await dispatchWorkflow("");
    addMsg("agent", "✓ Scheduled task trigger ho gaya. Actions tab me progress dekhein.");
  } catch (err) {
    addMsg("agent", `✗ ${err.message}`, "err");
  }
});

// ── tabs ─────────────────────────────────────────────────────────────────────
const TABS = ["tasks", "files", "setup"];
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  TABS.forEach((k) => $("tab-" + k).classList.toggle("hide", k !== name));
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
$("goSetup").addEventListener("click", () => switchTab("setup"));
$("cfgBtn").addEventListener("click", () => switchTab("setup"));

// ── setup form ───────────────────────────────────────────────────────────────
function showSetupMsg(kind, text) {
  const el = $("setupMsg");
  el.className = `settings-msg ${kind}`;
  el.textContent = text;
  el.classList.remove("hide");
}

$("setupForm").addEventListener("submit", async (e) => {
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
    showSetupMsg(
      "ok",
      `✓ Connected: ${r.full_name} · ${r.private ? "PRIVATE (cron nahi chalega — public karein)" : "public ✓"}`
    );
    setConfigUI();
    loadTasks();
    loadFiles();
  } catch (err) {
    showSetupMsg("err", `✗ ${err.message} — token ke permissions check karein.`);
  }
});

// ── boot ─────────────────────────────────────────────────────────────────────
autoDetect();
setConfigUI();
if (configured()) {
  loadTasks();
  loadFiles();
  setInterval(() => {
    if (!document.hidden) {
      loadTasks();
      loadFiles();
    }
  }, 8000);
}
