#!/usr/bin/env node
/**
 * GitHub ko zero se set up karta hai:
 *   repo create → files upload → secret set → Pages enable → verify
 *
 * Zaroorat: GH_SETUP_TOKEN (classic PAT, scopes: repo + workflow)
 *           GEMINI_KEY  (repo secret me daalne ke liye)
 *
 * Chalane ke baad dashboard live ho jata hai. Koi secret print nahi hota.
 */
import fs from "node:fs";
import path from "node:path";
import sodium from "libsodium-wrappers";

const TOKEN = process.env.GH_SETUP_TOKEN;
const GEMINI = process.env.GEMINI_KEY;
const REPO_NAME = process.env.REPO_NAME || "browser-agent";
const SRC = path.resolve(process.env.SRC_DIR || ".");

const SKIP_DIRS = new Set(["node_modules", ".git", "data", "uploads"]);
const SKIP_FILES = new Set([".env", ".DS_Store", "result.md"]);
const MAX_FILE_BYTES = 900_000; // Contents API practical limit

if (!TOKEN) {
  console.error("✗ GH_SETUP_TOKEN missing");
  process.exit(1);
}

const API = "https://api.github.com";
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${TOKEN}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "browser-agent-setup",
};

async function gh(pathname, opts = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...opts,
    headers: { ...headers, ...(opts.headers || {}) },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

function collectFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".github" && entry.name !== ".gitignore" && entry.name !== ".env.example") {
      continue;
    }
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join("/");

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectFiles(full, base, out);
    } else {
      if (SKIP_FILES.has(entry.name)) continue;
      const size = fs.statSync(full).size;
      if (size > MAX_FILE_BYTES) {
        console.log(`  ↷ skip (too big): ${rel}`);
        continue;
      }
      out.push({ full, rel, size });
    }
  }
  return out;
}

// ── 1. verify token ──────────────────────────────────────────────────────────
const me = await gh("/user");
if (!me.ok) {
  console.error(`✗ Token invalid (HTTP ${me.status}):`, me.json?.message || "");
  if (me.status === 401) console.error("  → Token expired ya galat. Naya banayein.");
  if (me.status === 403) console.error("  → Token me 'repo' scope hai?");
  process.exit(1);
}
const owner = me.json.login;
console.log(`✓ Token valid → @${owner}`);

// ── 2. create repo ───────────────────────────────────────────────────────────
let repo = await gh(`/repos/${owner}/${REPO_NAME}`);
if (repo.ok) {
  console.log(`✓ Repo pehle se hai: ${repo.json.full_name}`);
} else {
  const created = await gh(`/user/repos`, {
    method: "POST",
    body: JSON.stringify({
      name: REPO_NAME,
      description: "AI browser agent (GitHub Actions + Pages dashboard)",
      private: false,
      auto_init: false,
      has_issues: true,
    }),
  });
  if (!created.ok) {
    console.error(`✗ Repo create fail (${created.status}):`, created.json?.message || created.text.slice(0, 200));
    process.exit(1);
  }
  repo = created;
  console.log(`✓ Repo banaya: ${created.json.full_name} (public)`);
}
const defaultBranch = repo.json.default_branch || "main";

// ── 3. upload files ──────────────────────────────────────────────────────────
const files = collectFiles(SRC);
console.log(`\n▶ ${files.length} files upload ho rahi hain → branch: ${defaultBranch}`);

let uploaded = 0;
let failed = 0;
for (const f of files) {
  const content = fs.readFileSync(f.full).toString("base64");

  // pehle check: file already hai? to sha chahiye update ke liye
  const existing = await gh(`/repos/${owner}/${REPO_NAME}/contents/${encodeURIComponent(f.rel)}`);
  const sha = existing.ok ? existing.json.sha : undefined;

  const payload = {
    message: `${sha ? "update" : "add"} ${f.rel}`,
    content,
    branch: defaultBranch,
    ...(sha ? { sha } : {}),
  };

  const put = await gh(`/repos/${owner}/${REPO_NAME}/contents/${encodeURIComponent(f.rel)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });

  if (put.ok) {
    uploaded++;
    process.stdout.write(`  ✓ ${f.rel}\n`);
  } else {
    failed++;
    process.stdout.write(`  ✗ ${f.rel} — ${put.status} ${put.json?.message || ""}\n`);
  }
}
console.log(`\n✓ ${uploaded} uploaded, ${failed} failed`);

// ── 4. repo secret: GEMINI_API_KEY ───────────────────────────────────────────
if (GEMINI) {
  await sodium.ready;
  const pk = await gh(`/repos/${owner}/${REPO_NAME}/actions/secrets/public-key`);
  if (!pk.ok) {
    console.error(`✗ Secret public key nahi mili (${pk.status}) — token me 'repo' scope?`);
  } else {
    const sealed = sodium.crypto_box_seal(
      GEMINI,
      Buffer.from(pk.json.key, "base64")
    );
    const put = await gh(`/repos/${owner}/${REPO_NAME}/actions/secrets/GEMINI_API_KEY`, {
      method: "PUT",
      body: JSON.stringify({
        encrypted_value: Buffer.from(sealed).toString("base64"),
        key_id: pk.json.key_id,
      }),
    });
    console.log(put.ok ? "✓ Secret GEMINI_API_KEY set" : `✗ Secret set fail (${put.status})`);
  }
} else {
  console.log("⚠ GEMINI_KEY missing — secret set nahi hua (baad me Settings → Secrets se daalein)");
}

// ── 5. repo variables (optional) ─────────────────────────────────────────────
for (const [name, value] of [["GEMINI_MODEL", "gemini-2.5-flash"], ["MAX_STEPS", "45"]]) {
  const r = await gh(`/repos/${owner}/${REPO_NAME}/actions/variables`, {
    method: "POST",
    body: JSON.stringify({ name, value }),
  });
  if (!r.ok && r.status !== 409) {
    await gh(`/repos/${owner}/${REPO_NAME}/actions/variables/${name}`, {
      method: "PATCH",
      body: JSON.stringify({ name, value }),
    });
  }
}
console.log("✓ Variables set (model, max steps)");

// ── 6. enable Pages (/docs) ──────────────────────────────────────────────────
let pages = await gh(`/repos/${owner}/${REPO_NAME}/pages`);
if (pages.ok) {
  console.log("✓ Pages pehle se enabled:", pages.json.html_url);
} else {
  const r = await gh(`/repos/${owner}/${REPO_NAME}/pages`, {
    method: "POST",
    body: JSON.stringify({ source: { branch: defaultBranch, path: "/docs" } }),
  });
  if (r.ok) {
    pages = r;
    console.log("✓ Pages enable (branch:", defaultBranch, "· /docs)");
  } else {
    console.error(`✗ Pages enable fail (${r.status}):`, r.json?.message || "");
  }
}

// ── 7. verify ────────────────────────────────────────────────────────────────
await new Promise((r) => setTimeout(r, 4000));
const dash = await gh(`/repos/${owner}/${REPO_NAME}/contents/docs/index.html`);
const wf = await gh(`/repos/${owner}/${REPO_NAME}/contents/.github/workflows/agent.yml`);

console.log("\n" + "═".repeat(58));
console.log("  SETUP COMPLETE");
console.log("═".repeat(58));
console.log(`  Repo      : https://github.com/${owner}/${REPO_NAME}`);
console.log(`  Actions   : https://github.com/${owner}/${REPO_NAME}/actions`);
console.log(`  Secrets   : https://github.com/${owner}/${REPO_NAME}/settings/secrets/actions`);
console.log(`  Dashboard : https://${owner.toLowerCase()}.github.io/${REPO_NAME}/`);
console.log(`  docs ok   : ${dash.ok ? "✓" : "✗"} · workflow ok: ${wf.ok ? "✓" : "✗"}`);
console.log("═".repeat(58));
if (failed) console.log(`\n⚠ ${failed} file fail hui — upar list dekhein`);
