/* Browser Agent — dashboard client */
const KEY_STORE = "ba_dash_key";
let dashKey = localStorage.getItem(KEY_STORE) || "";
let state = null;
let watching = new Map(); // runId -> { el, logEl, timer }

// ── api helper ────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(dashKey ? { "x-dash-key": dashKey } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    const k = prompt("Dashboard password:");
    if (k) {
      dashKey = k;
      localStorage.setItem(KEY_STORE, k);
      return api(path, opts);
    }
    throw new Error("unauthorized");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || json.message || `HTTP ${res.status}`);
  return json;
}

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── chat ─────────────────────────────────────────────────────────────────────
const chat = $("chat");

function addUserMsg(text) {
  $("chatEmpty")?.remove();
  const el = document.createElement("div");
  el.className = "msg user";
  el.innerHTML = `<div class="who">You</div><div class="bubble">${esc(text)}</div>`;
  chat.appendChild(el);
  scrollChat();
}

function addAgentMsg(runId) {
  $("chatEmpty")?.remove();
  const el = document.createElement("div");
  el.className = "msg agent";
  el.dataset.run = runId;
  el.innerHTML = `
    <div class="who">Agent <span class="badge running" data-badge>running</span></div>
    <div class="bubble">
      <div data-status>Kaam shuru…</div>
      <details class="steps" open>
        <summary>Steps</summary>
        <div class="log" data-log></div>
      </details>
    </div>`;
  chat.appendChild(el);
  scrollChat();

  const entry = {
    el,
    logEl: el.querySelector("[data-log]"),
    statusEl: el.querySelector("[data-status]"),
    badge: el.querySelector("[data-badge]"),
    lastCount: 0,
  };
  watching.set(runId, entry);
  pollRun(runId);
}

function scrollChat() {
  chat.scrollTop = chat.scrollHeight;
}

function renderLogEntry(e) {
  if (e.type === "tool") {
    const a = e.args || {};
    const detail =
      a.query || a.url || a.text || a.selector || a.index !== undefined
        ? String(a.query || a.url || a.text || a.selector || `[${a.index}]`).slice(0, 90)
        : "";
    return `<div class="log-item"><b>${esc(e.name)}</b> ${esc(detail)}</div>`;
  }
  if (e.type === "tool_error") return `<div class="log-item err">${esc(e.name)}: ${esc(e.message)}</div>`;
  if (e.type === "say") return `<div class="log-item say">${esc(e.text.slice(0, 300))}</div>`;
  if (e.type === "thinking") return `<div class="log-item">· step ${e.step}</div>`;
  if (e.type === "start") return `<div class="log-item">▶ ${esc(String(e.text).slice(0, 120))}</div>`;
  return "";
}

async function pollRun(runId) {
  const entry = watching.get(runId);
  if (!entry) return;
  try {
    const run = await api(`/api/run/${runId}`);

    const log = run.log || [];
    if (log.length !== entry.lastCount) {
      entry.logEl.innerHTML = log.map(renderLogEntry).filter(Boolean).join("");
      entry.lastCount = log.length;
      entry.logEl.scrollTop = entry.logEl.scrollHeight;
    }

    if (run.status === "running") {
      entry.statusEl.textContent = "Chal raha hai…";
      setTimeout(() => pollRun(runId), 1200);
      return;
    }

    entry.badge.className = `badge ${run.status}`;
    entry.badge.textContent = run.status;
    entry.statusEl.innerHTML =
      run.status === "error"
        ? `<span style="color:var(--danger)">Error: ${esc(run.error)}</span>`
        : esc(run.result || "(no result)");
    entry.el.querySelector("details")?.removeAttribute("open");
    watching.delete(runId);
    scrollChat();
    refreshState();
  } catch (err) {
    entry.statusEl.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
    watching.delete(runId);
  }
}

// ── send ─────────────────────────────────────────────────────────────────────
const form = $("composer");
const input = $("input");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message) return;

  if (state && !state.hasKey) {
    switchTab("settings");
    showSettingsMsg("err", "Pehle Gemini API key add karein — phir task chalega.");
    return;
  }

  input.value = "";
  addUserMsg(message);
  const sendBtn = $("sendBtn");
  sendBtn.disabled = true;
  try {
    const { runId } = await api("/api/chat", { method: "POST", body: JSON.stringify({ message }) });
    addAgentMsg(runId);
  } catch (err) {
    addUserMsg(`⚠ ${err.message}`);
  } finally {
    sendBtn.disabled = false;
  }
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) form.requestSubmit();
});

document.querySelectorAll(".sug").forEach((b) =>
  b.addEventListener("click", () => {
    input.value = b.textContent.trim();
    input.focus();
  })
);

$("clearChat").addEventListener("click", () => {
  chat.innerHTML = "";
  watching.clear();
  location.reload();
});

$("goSettings").addEventListener("click", () => switchTab("settings"));
$("settingsBtn").addEventListener("click", () => switchTab("settings"));

// ── tabs ─────────────────────────────────────────────────────────────────────
const TABS = ["runs", "sched", "files", "settings"];

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  TABS.forEach((k) => $("tab-" + k).classList.toggle("hide", k !== name));
}

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => switchTab(t.dataset.tab))
);

// ── state ────────────────────────────────────────────────────────────────────
async function refreshState() {
  try {
    state = await api("/api/state");
    $("modelPill").textContent = state.model;
    $("modePill").textContent = state.headless ? "headless" : "visible";
    $("keyWarn").classList.toggle("hide", state.hasKey);
    $("setupBanner").classList.toggle("hide", state.hasKey);

    renderStatus(state);
    renderRuns(state.runs);
    renderSchedules(state.schedules);
    renderFiles(state.outputs);
  } catch (err) {
    console.warn("state error", err.message);
  }
}

function renderStatus(s) {
  const ks = s.keyStatus || {};
  const invalid = s.hasKey && ks.checked && ks.ok === false;
  const badge = $("keyBadge");
  badge.className = `badge ${s.hasKey && !invalid ? "ok" : "off"}`;
  badge.textContent = !s.hasKey ? "key missing" : invalid ? "key invalid ✗" : ks.ok ? "key valid ✓" : "key set";

  const line = `Model: <code>${esc(s.model)}</code> · ${s.headless ? "headless" : "visible"} · ${s.maxSteps} steps`;
  $("statusMeta").innerHTML = !s.hasKey
    ? "Koi API key set nahi hai. Neeche paste karein."
    : invalid
      ? `<span style="color:var(--danger)">${esc(ks.message || "Key valid nahi hai")}</span><br>${line}`
      : `Key: <code>${esc(s.keyMask)}</code> · ${line}`;

  $("keyWarn").textContent = invalid ? "API key invalid" : "API key missing";
  $("keyWarn").classList.toggle("hide", s.hasKey && !invalid);
  $("setupBanner").classList.toggle("hide", s.hasKey && !invalid);

  // form defaults (sirf agar user ne kuch type nahi kiya)
  if (!$("fApiKey").value) {
    $("fApiKey").placeholder = s.hasKey ? `${s.keyMask} — badalna ho to nayi paste karein` : "AIza… yahan paste karein";
  }
  const modelSel = $("fModel");
  if (!modelSel.options.length) {
    modelSel.innerHTML = (s.models || [])
      .map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`)
      .join("");
  }
  if (document.activeElement !== modelSel) modelSel.value = s.model;
  if (document.activeElement !== $("fMaxSteps")) $("fMaxSteps").value = s.maxSteps;
  if (document.activeElement !== $("fHeadless")) $("fHeadless").value = String(s.headless);
}

function renderRuns(runs) {
  const el = $("runsList");
  if (!runs.length) {
    el.innerHTML = `<p class="hint">Abhi koi run nahi hua.</p>`;
    return;
  }
  el.innerHTML = runs
    .map(
      (r) => `
    <div class="card">
      <div class="title">${esc(r.goal.slice(0, 100))}<span class="badge ${r.status}">${r.status}</span></div>
      <div class="meta">
        <span>${new Date(r.createdAt).toLocaleString()}</span>
        <span>· ${r.source}</span>
        <span>· ${r.logCount} steps</span>
      </div>
      ${r.result ? `<pre>${esc(String(r.result).slice(0, 400))}</pre>` : ""}
      ${r.error ? `<pre style="color:var(--danger)">${esc(r.error)}</pre>` : ""}
    </div>`
    )
    .join("");
}

function renderSchedules(list) {
  const el = $("schedList");
  if (!list.length) {
    el.innerHTML = `<p class="hint">Koi schedule nahi. Upar se add karein.</p>`;
    return;
  }
  el.innerHTML = list
    .map(
      (s) => `
    <div class="card">
      <div class="title">${esc(s.name)} <span class="badge ${s.enabled ? "done" : ""}">${s.enabled ? "on" : "paused"}</span></div>
      <div class="meta"><code>${esc(s.cron)}</code>${s.lastRun ? `<span>· last: ${new Date(s.lastRun).toLocaleString()} (${s.lastStatus || "-"})</span>` : ""}</div>
      <pre>${esc(s.goal.slice(0, 200))}</pre>
      <div class="actions">
        <button class="btn tiny" data-run="${s.id}">Run now</button>
        <button class="btn tiny" data-toggle="${s.id}">${s.enabled ? "Pause" : "Resume"}</button>
        <button class="btn tiny danger" data-del="${s.id}">Delete</button>
      </div>
    </div>`
    )
    .join("");

  el.querySelectorAll("[data-run]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        const { runId } = await api(`/api/schedules/${b.dataset.run}/run`, { method: "POST" });
        addUserMsg("[scheduled task manual run]");
        addAgentMsg(runId);
      } catch (e) {
        alert(e.message);
      } finally {
        b.disabled = false;
      }
    })
  );
  el.querySelectorAll("[data-toggle]").forEach((b) =>
    b.addEventListener("click", async () => {
      const s = state.schedules.find((x) => x.id === b.dataset.toggle);
      await api(`/api/schedules/${s.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !s.enabled }) });
      refreshState();
    })
  );
  el.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this schedule?")) return;
      await api(`/api/schedules/${b.dataset.del}`, { method: "DELETE" });
      refreshState();
    })
  );
}

function renderFiles(files) {
  const el = $("filesList");
  if (!files.length) {
    el.innerHTML = `<p class="hint">Koi file nahi bani abhi.</p>`;
    return;
  }
  el.innerHTML = files
    .map(
      (f) => `
    <div class="card">
      <div class="title">${esc(f.name)}</div>
      <div class="meta"><span>${(f.size / 1024).toFixed(1)} KB</span><span>· ${new Date(f.modified).toLocaleString()}</span></div>
      <div class="actions"><a class="btn tiny" href="/outputs/${encodeURIComponent(f.name)}" download>Download</a></div>
    </div>`
    )
    .join("");
}

// ── schedule form ────────────────────────────────────────────────────────────
$("sPreset").addEventListener("change", (e) => {
  if (e.target.value) $("sCron").value = e.target.value;
});

$("schedForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("sName").value.trim();
  const goal = $("sGoal").value.trim();
  const cron = $("sCron").value.trim();
  if (!goal || !cron) return alert("Task aur schedule zaroori hai");
  try {
    await api("/api/schedules", { method: "POST", body: JSON.stringify({ name, goal, cron }) });
    $("sName").value = "";
    $("sGoal").value = "";
    $("sCron").value = "";
    refreshState();
  } catch (err) {
    alert(err.message);
  }
});

// ── settings form ────────────────────────────────────────────────────────────
function showSettingsMsg(kind, text) {
  const el = $("settingsMsg");
  el.className = `settings-msg ${kind}`;
  el.textContent = text;
  el.classList.remove("hide");
}

$("testKeyBtn").addEventListener("click", async () => {
  const btn = $("testKeyBtn");
  const key = $("fApiKey").value.trim();
  if (!key && !state?.hasKey) return showSettingsMsg("err", "Pehle key paste karein.");

  btn.disabled = true;
  showSettingsMsg("ok", "Test ho raha hai…");
  try {
    const r = await api("/api/settings/test", {
      method: "POST",
      body: JSON.stringify({ apiKey: key || undefined }),
    });
    showSettingsMsg("ok", r.message);
  } catch (err) {
    showSettingsMsg("err", err.message);
  } finally {
    btn.disabled = false;
  }
});

$("settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("saveBtn");
  btn.disabled = true;

  const payload = {
    model: $("fModel").value,
    maxSteps: Number($("fMaxSteps").value),
    headless: $("fHeadless").value === "true",
  };
  const key = $("fApiKey").value.trim();
  if (key) payload.apiKey = key;
  const pw = $("fPassword").value.trim();
  if (pw) payload.dashboardPassword = pw;

  try {
    const r = await api("/api/settings", { method: "POST", body: JSON.stringify(payload) });
    if (r.changed.includes("apiKey")) {
      $("fApiKey").value = "";
      $("fApiKey").placeholder = `${r.settings.keyMask} — badalna ho to nayi paste karein`;
    }
    if (r.changed.includes("dashboardPassword")) {
      dashKey = pw;
      localStorage.setItem(KEY_STORE, pw);
      $("fPassword").value = "";
    }
    showSettingsMsg(
      "ok",
      `Save ho gaya ✓ (${r.changed.join(", ") || "kuch nahi badla"}). Server restart ki zaroorat nahi.`
    );
    refreshState();
  } catch (err) {
    showSettingsMsg("err", err.message);
  } finally {
    btn.disabled = false;
  }
});

// ── boot ─────────────────────────────────────────────────────────────────────
refreshState();
setInterval(refreshState, 5000);
