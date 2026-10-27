// Playwright wrapper + the actual tool implementations the LLM can call.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadSkill } from "./skills.js";

const OUTPUTS = path.resolve("./outputs");
fs.mkdirSync(OUTPUTS, { recursive: true });

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** SSRF / metadata protection — agent ko andar ke addresses pe mat jaane do */
export function assertSafeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error(`URL valid nahi: ${raw}`);
  }
  if (!/^https?:$/.test(u.protocol)) {
    throw new Error(`Sirf http/https allowed hai (mila: ${u.protocol})`);
  }
  const host = u.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) || // cloud metadata
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^0\./.test(host) ||
    host === "::1" ||
    /^\[?::1\]?$/.test(host) ||
    /^\[?f[cd]/i.test(host);
  if (blocked) {
    throw new Error(`Ye address blocked hai (internal/metadata): ${host}`);
  }
  return u.toString();
}

export class BrowserManager {
  constructor({ userDataDir, headless }) {
    this.userDataDir = path.resolve(userDataDir || "./data/browser-profile");
    this.forceHeadless = headless; // undefined = .env / UI setting se padho
    this.context = null;
    this.activePage = null;
    this.lastElements = [];
    this.notes = [];
    // task ka data board: "kahan kya dalna hai" — tabs/phases ke paar yaad rehta hai
    this.board = new Map();
    this.lastHostHit = new Map(); // per-domain politeness
    this.lastSkillHost = "";
  }

  // Har launch pe fresh padho — UI se headless toggle karne par restart ki zaroorat nahi.
  get isHeadless() {
    if (this.forceHeadless !== undefined) return this.forceHeadless;
    return String(process.env.HEADLESS ?? "true") !== "false";
  }

  async ensure() {
    if (this.context) {
      // Guard against a context that died silently.
      try {
        void this.context.pages();
        return this.context;
      } catch {
        this.context = null;
      }
    }
    fs.mkdirSync(this.userDataDir, { recursive: true });
    this.context = await chromium.launchPersistentContext(this.userDataDir, {
      headless: this.isHeadless,
      viewport: { width: 1366, height: 900 },
      userAgent: UA,
      locale: "en-US",
      timezoneId: "Asia/Kolkata",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
    this.context.setDefaultTimeout(20000);

    // dialogs (alert/confirm/prompt) auto-accept — warna agent hang ho jata hai
    this.context.on("page", (pg) => {
      pg.on("dialog", (d) => d.accept().catch(() => {}));
    });
    for (const pg of this.context.pages()) pg.on("dialog", (d) => d.accept().catch(() => {}));

    // clipboard copy/paste ke liye permission (headless me zaroori)
    try {
      await this.context.grantPermissions(["clipboard-read", "clipboard-write"]);
    } catch {}
    return this.context;
  }

  /** bahut zyada tab khulne pe purane band karo (runner RAM bachane ke liye) */
  async trimTabs(maxTabs = 8) {
    const ctx = await this.ensure();
    const pages = ctx.pages();
    if (pages.length <= maxTabs) return 0;
    let closed = 0;
    for (const p of pages.slice(0, pages.length - maxTabs)) {
      if (p === this.activePage) continue;
      try {
        await p.close();
        closed++;
      } catch {}
    }
    return closed;
  }

  async page() {
    const ctx = await this.ensure();
    // Respect the tab the agent explicitly switched to; fall back to the newest tab.
    if (this.activePage && !this.activePage.isClosed()) return this.activePage;
    const pages = ctx.pages();
    this.activePage = pages.length ? pages[pages.length - 1] : await ctx.newPage();
    return this.activePage;
  }

  async close() {
    if (this.context) {
      try {
        await this.context.close();
      } catch {}
      this.context = null;
    }
    this.activePage = null;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  async settle(page) {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
    } catch {}
    try {
      await page.waitForTimeout(500);
    } catch {}
  }

  async snapshot(page, { maxText = 1400, compact = false } = {}) {
    const info = await page
      .evaluate((limit) => {
        const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
        const text = clean(document.body?.innerText || "").slice(0, limit);
        const heads = [...document.querySelectorAll("h1,h2,h3")]
          .slice(0, 25)
          .map((h) => clean(h.innerText).slice(0, 90))
          .filter(Boolean);
        return { title: document.title, url: location.href, text, heads };
      }, maxText)
      .catch(() => ({ title: "", url: page.url(), text: "", heads: [] }));

    let cap = { found: false };
    try {
      cap = await this.detectCaptcha(page);
    } catch {}

    return [
      cap.found ? `⚠️ CAPTCHA DETECTED (${cap.type}) — niche diye steps follow karo.` : "",
      `URL: ${info.url}`,
      `TITLE: ${info.title}`,
      info.heads.length ? `HEADINGS: ${info.heads.join(" | ")}` : "",
      "VISIBLE TEXT:",
      info.text || "(empty)",
    ]
      .filter(Boolean)
      .join("\n");
  }

  async resolveLocator(page, { selector, index, text }) {
    if (index !== undefined && index !== null && this.lastElements.length) {
      return page.locator(`[data-bai="${index}"]`).first();
    }
    if (text) {
      const byRole = page.getByRole("link", { name: text, exact: false }).first();
      if (await byRole.count().catch(() => 0)) return byRole;
      const byBtn = page.getByRole("button", { name: text, exact: false }).first();
      if (await byBtn.count().catch(() => 0)) return byBtn;
      // form fields: placeholder / label text se
      const byPlaceholder = page.getByPlaceholder(text, { exact: false }).first();
      if (await byPlaceholder.count().catch(() => 0)) return byPlaceholder;
      const byLabel = page.getByLabel(text, { exact: false }).first();
      if (await byLabel.count().catch(() => 0)) return byLabel;
      const byAlt = page.getByAltText(text, { exact: false }).first();
      if (await byAlt.count().catch(() => 0)) return byAlt;
      return page.getByText(text, { exact: false }).first();
    }
    if (selector) return page.locator(selector).first();
    throw new Error("Provide one of: index, text, selector");
  }

  // ── tool dispatch ──────────────────────────────────────────────────────────

  /** page pe captcha hai? type + hint */
  async detectCaptcha(page) {
    try {
      return await page.evaluate(() => {
        const html = document.documentElement.innerHTML;
        const text = (document.body?.innerText || "").toLowerCase();
        const marks = [
          [/recaptcha|g-recaptcha/i, "reCAPTCHA"],
          [/hcaptcha/i, "hCaptcha"],
          [/turnstile|cf-challenge|checking your browser/i, "Cloudflare Turnstile"],
          [/arkose|funcaptcha/i, "Arkose"],
          [/captcha/i, "generic captcha"],
        ];
        let type = "";
        for (const [re, name] of marks) if (re.test(html)) { type = type || name; }
        const wordy = /verify (that )?you are (a )?human|unusual traffic|are you a robot|access denied|bot detection|just a moment/i.test(text);
        const frames = [...document.querySelectorAll("iframe")].some((f) =>
          /recaptcha|hcaptcha|turnstile|challenge/i.test(f.src || "")
        );
        if (!type && !wordy && !frames) return { found: false };
        return { found: true, type: type || (frames ? "captcha iframe" : "bot-check text") };
      });
    } catch {
      return { found: false };
    }
  }

  /** board ka compact text — agent ke memory carry ke liye */
  boardSnapshot(limit = 30) {
    if (!this.board.size) return "";
    return [...this.board.entries()]
      .slice(-limit)
      .map(([k, v]) => `- ${k} = ${String(v).replace(/\s+/g, " ").slice(0, 200)}`)
      .join("\n");
  }

  async runTool(name, args = {}) {
    const page = await this.page();
    const out = { text: "", images: [] };

    switch (name) {
      case "navigate": {
        const want = assertSafeUrl(String(args.url || ""));
        const cur = page.url();
        const norm = (u) => u.replace(/\/$/, "").split("#")[0];
        if (cur && cur !== "about:blank" && norm(cur) === norm(want)) {
          out.text = `Already isi page pe ho (${want}) — navigate dobara ki zaroorat nahi.\n${await this.snapshot(page)}`;
          break;
        }
        try {
          await page.goto(want, { waitUntil: "domcontentloaded", timeout: 45000 });
        } catch (e) {
          throw new Error(`${want} khulne me dikkat: ${e.message.slice(0, 80)} — dusra URL ya search try karo`);
        }
        await this.settle(page);

        // per-domain politeness (1.2s gap)
        try {
          const host = new URL(page.url()).hostname;
          const prev = this.lastHostHit.get(host) || 0;
          const wait = 1200 - (Date.now() - prev);
          if (wait > 0 && prev) await page.waitForTimeout(Math.min(wait, 1200));
          this.lastHostHit.set(host, Date.now());
        } catch {}

        let skill = "";
        try {
          const host = new URL(page.url()).hostname;
          if (host !== this.lastSkillHost) {
            this.lastSkillHost = host;
            const sk = loadSkill(host);
            if (sk) skill = `\n\n📚 SITE NOTES (pichhle runs se seekha — use karo):\n${sk}`;
          }
        } catch {}

        out.text = `Navigated.${skill}\n${await this.snapshot(page)}`;
        break;
      }

      case "search": {
        const q = String(args.query || "").trim();
        if (!q) throw new Error("query required");

        const parseBing = () =>
          page
            .evaluate(() => {
              // Bing wraps links in /ck/a?...&u=a1<base64url> — unwrap to the real URL.
              const unwrap = (href) => {
                try {
                  const u = new URL(href).searchParams.get("u");
                  if (!u || !u.startsWith("a1")) return href;
                  let b = u.slice(2).replace(/-/g, "+").replace(/_/g, "/");
                  while (b.length % 4) b += "=";
                  return decodeURIComponent(escape(atob(b)));
                } catch {
                  return href;
                }
              };
              const rows = [];
              document.querySelectorAll("#b_results > li.b_algo").forEach((el, i) => {
                if (i > 15) return;
                const a = el.querySelector("h2 a");
                if (!a) return;
                const title = (a.textContent || "").replace(/\s+/g, " ").trim();
                if (!title) return;
                rows.push({
                  n: i + 1,
                  title: title.slice(0, 120),
                  url: unwrap(a.href),
                  snippet: (el.querySelector(".b_caption p, p")?.textContent || "")
                    .replace(/\s+/g, " ")
                    .trim()
                    .slice(0, 240),
                });
              });
              return rows;
            })
            .catch(() => []);

        const parseDdg = () =>
          page
            .evaluate(() => {
              const rows = [];
              document.querySelectorAll(".result").forEach((el, i) => {
                if (i > 15) return;
                const a = el.querySelector(".result__a");
                if (!a) return;
                rows.push({
                  n: i + 1,
                  title: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
                  url: a.href,
                  snippet: (el.querySelector(".result__snippet")?.textContent || "")
                    .replace(/\s+/g, " ")
                    .trim()
                    .slice(0, 240),
                });
              });
              return rows;
            })
            .catch(() => []);

        // Bing first (most reliable headless), DuckDuckGo html as backup.
        let results = [];
        let engine = "Bing";
        try {
          await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en`, {
            waitUntil: "domcontentloaded",
            timeout: 45000,
          });
          await page.waitForSelector("#b_results > li.b_algo", { timeout: 12000 }).catch(() => {});
          await page.waitForTimeout(900);
          results = await parseBing();
        } catch {}

        if (!results.length) {
          engine = "DuckDuckGo";
          try {
            await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
              waitUntil: "domcontentloaded",
              timeout: 45000,
            });
            await page.waitForSelector(".result", { timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(700);
            results = await parseDdg();
          } catch {}
        }

        out.text = results.length
          ? `Search results for "${q}" (${engine}):\n` +
            results.map((r) => `${r.n}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n")
          : `No structured results from Bing/DuckDuckGo. Page snapshot below — read it and decide.\n${await this.snapshot(page)}`;
        break;
      }

      case "elements": {
        const els = await page.evaluate(() => {
          const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
          const sel =
            'a,button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[contenteditable="true"]';
          const rows = [];
          let i = 0;
          document.querySelectorAll(sel).forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) return;
            const st = getComputedStyle(el);
            if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return;
            if (r.top > window.innerHeight + 3000) return;
            let label = clean(
              el.innerText ||
                el.value ||
                el.getAttribute("aria-label") ||
                el.getAttribute("placeholder") ||
                el.getAttribute("title") ||
                el.getAttribute("name") ||
                ""
            ).slice(0, 80);
            if (!label) label = `<${el.tagName.toLowerCase()}>`;
            el.setAttribute("data-bai", String(i));
            rows.push({
              i,
              tag: el.tagName.toLowerCase(),
              type: el.getAttribute("type") || "",
              label,
            });
            i++;
            if (i >= 120) return;
          });
          return rows;
        });
        this.lastElements = els;
        out.text = els.length
          ? els.map((e) => `[${e.i}] ${e.tag}${e.type ? `(${e.type})` : ""} — ${e.label}`).join("\n")
          : "No interactive elements found.";
        break;
      }

      case "click": {
        const ctx = await this.ensure();
        const before = ctx.pages().length;
        // click ke liye 3 tarike try karo
        let clicked = false;
        const tries = [];
        if (args.index !== undefined) tries.push({ index: args.index });
        if (args.text) tries.push({ text: args.text });
        if (args.selector) tries.push({ selector: args.selector });
        if (!tries.length) tries.push(args);

        let lastErr = null;
        for (const t of tries) {
          try {
            const l = await this.resolveLocator(page, t);
            if (!(await l.count().catch(() => 0))) continue;
            await l.click({ timeout: 12000 });
            clicked = true;
            break;
          } catch (e) {
            lastErr = e;
          }
        }
        if (!clicked) {
          try {
            const els = await page.evaluate(() => document.querySelectorAll("a,button").length);
            throw new Error(`Click nahi hua (${lastErr?.message?.slice(0, 60) || "element nahi mila"}). Page pe ${els} links/buttons hain — elements() se index lo.`);
          } catch (e2) {
            if (e2.message.startsWith("Click nahi hua")) throw e2;
            throw new Error(`Click nahi hua: ${lastErr?.message?.slice(0, 80) || "element nahi mila"}`);
          }
        }
        await page.waitForTimeout(350);
        // popup / new tab khul gaya?
        const after = ctx.pages();
        if (after.length > before) {
          this.activePage = after[after.length - 1];
          await this.activePage.waitForLoadState("domcontentloaded").catch(() => {});
          out.text = `Clicked — naya tab khul gaya, us pe switch kar diya.\n${await this.snapshot(this.activePage)}`;
          break;
        }
        await this.settle(page);
        out.text = `Clicked.\n${await this.snapshot(page)}`;
        break;
      }

      case "hover": {
        const loc = await this.resolveLocator(page, args);
        await loc.hover({ timeout: 15000 });
        await page.waitForTimeout(500);
        out.text = `Hover kiya.\n${await this.snapshot(page)}`;
        break;
      }

      case "select": {
        const loc = await this.resolveLocator(page, args);
        const val = args.value ?? args.label ?? "";
        try {
          await loc.selectOption({ label: String(val) });
        } catch {
          await loc.selectOption(String(val));
        }
        await this.settle(page);
        out.text = `Select kiya "${val}".\n${await this.snapshot(page)}`;
        break;
      }

      case "check": {
        const loc = await this.resolveLocator(page, args);
        if (args.checked === false) await loc.uncheck({ timeout: 10000 });
        else await loc.check({ timeout: 10000 });
        await this.settle(page);
        out.text = `Checkbox ${args.checked === false ? "unchecked" : "checked"}.\n${await this.snapshot(page)}`;
        break;
      }

      case "fill_form": {
        const fields = args.fields || [];
        if (!fields.length) throw new Error("fields array required");
        const results = [];
        for (const f of fields) {
          try {
            // label → text (resolveLocator text/index/selector leta hai)
            const locArgs = { selector: f.selector, index: f.index, text: f.text || f.label };
            const loc = await this.resolveLocator(page, locArgs);
            if (f.kind === "select") await loc.selectOption({ label: f.value }).catch(() => loc.selectOption(f.value));
            else if (f.kind === "check") await loc.check({ timeout: 8000 });
            else {
              await loc.click({ timeout: 8000 }).catch(() => {});
              await loc.fill(String(f.value ?? ""));
            }
            results.push(`✓ ${f.label || f.selector || f.text}`);
          } catch (e) {
            results.push(`✗ ${f.label || f.selector || f.text}: ${e.message.slice(0, 50)}`);
          }
        }
        await this.settle(page);
        out.text = `Form fill:\n${results.join("\n")}\n\n${await this.snapshot(page)}`;
        break;
      }

      case "extract_table": {
        const sel = args.selector || "table";
        const limit = Math.min(Number(args.limit) || 500, 2000);
        const rows = await page.evaluate(
          ({ sel, limit }) => {
            const tbl = document.querySelector(sel);
            if (!tbl) return null;
            const out = [];
            tbl.querySelectorAll("tr").forEach((tr, i) => {
              if (i >= limit) return;
              const cells = [...tr.querySelectorAll("th,td")].map((c) =>
                (c.innerText || "").replace(/\s+/g, " ").trim()
              );
              if (cells.some(Boolean)) out.push(cells);
            });
            return out;
          },
          { sel, limit }
        );
        if (!rows || !rows.length) throw new Error("Table nahi mili / khaali hai");
        const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
        out.text = `Table mili (${rows.length} rows). CSV format me:\n${csv.slice(0, 6000)}\n\nTIP: save_results() se ise file me daal do.`;
        break;
      }

      case "auto_scroll": {
        const rounds = Math.min(Number(args.rounds) || 8, 30);
        let last = 0;
        let changed = 0;
        for (let i = 0; i < rounds; i++) {
          await page.mouse.wheel(0, 2200);
          await page.waitForTimeout(900);
          const h = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
          if (h === last) break;
          last = h;
          changed++;
        }
        out.text = `Auto-scroll ${changed} baar (page height ${last}px).\n${await this.snapshot(page)}`;
        break;
      }

      case "upload": {
        const sel = args.selector || 'input[type="file"]';
        const f = String(args.file || "");
        const abs = path.isAbsolute(f) ? f : path.resolve(OUTPUTS, f);
        if (!fs.existsSync(abs)) throw new Error(`File nahi mili: ${f} (outputs/ me rakhein)`);
        await page.setInputFiles(sel, abs, { timeout: 15000 });
        await this.settle(page);
        out.text = `File upload set: ${path.basename(abs)}\n${await this.snapshot(page)}`;
        break;
      }

      case "download": {
        const [dl] = await Promise.all([
          page.waitForEvent("download", { timeout: 30000 }),
          (async () => {
            if (args.index !== undefined || args.text || args.selector) {
              const loc = await this.resolveLocator(page, args);
              await loc.click({ timeout: 15000 });
            } else throw new Error("index/text/selector required");
          })(),
        ]);
        const name = dl.suggestedFilename() || `download-${Date.now()}`;
        const dest = path.join(OUTPUTS, name.replace(/[^\w.-]/g, "_"));
        await dl.saveAs(dest);
        out.text = `Download ho gaya: outputs/${path.basename(dest)}`;
        break;
      }

      case "iframes": {
        const frames = page.frames().filter((f) => f !== page.mainFrame());
        out.text = frames.length
          ? frames.map((f, i) => `[${i}] ${f.name() || "(unnamed)"} — ${f.url().slice(0, 90)}`).join("\n") +
            "\n\nTIP: frame ke andar kaam karne ke liye elements()/click() ke saath wahi selector use karein."
          : "Koi iframe nahi mila.";
        break;
      }

      case "type": {
        const loc = await this.resolveLocator(page, args);
        if (!(await loc.count().catch(() => 0))) throw new Error("Element not found for type");
        await loc.click({ timeout: 15000 }).catch(() => {});
        await loc.fill("");
        await loc.type(String(args.text ?? ""), { delay: 25 });
        if (args.submit) {
          await loc.press("Enter");
          await this.settle(page);
        }
        out.text = `Typed.\n${await this.snapshot(page)}`;
        break;
      }

      case "press": {
        await page.keyboard.press(args.key || "Enter");
        await this.settle(page);
        out.text = `Pressed ${args.key || "Enter"}.\n${await this.snapshot(page)}`;
        break;
      }

      case "scroll": {
        const amount = Number(args.amount) > 0 ? Number(args.amount) : 900;
        const dy = (args.direction || "down") === "up" ? -amount : amount;
        await page.mouse.wheel(0, dy);
        await page.waitForTimeout(700);
        out.text = `Scrolled ${args.direction || "down"} ${amount}px.\n${await this.snapshot(page)}`;
        break;
      }

      case "back": {
        await page.goBack({ timeout: 30000 });
        await this.settle(page);
        out.text = `Back.\n${await this.snapshot(page)}`;
        break;
      }

      case "forward": {
        await page.goForward({ timeout: 30000 });
        await this.settle(page);
        out.text = `Forward.\n${await this.snapshot(page)}`;
        break;
      }

      case "wait": {
        if (args.selector) await page.waitForSelector(args.selector, { timeout: 30000 });
        else await page.waitForTimeout(Math.min(Number(args.ms) || 2000, 20000));
        out.text = "Waited.";
        break;
      }

      case "read_page": {
        const limit = Math.min(Number(args.limit) || 3000, 12000);
        const txt = await page.evaluate((l) => (document.body?.innerText || "").slice(0, l), limit);
        out.text = `URL: ${page.url()}\n\n${txt || "(no text)"}`;
        break;
      }

      case "extract": {
        const sel = args.selector;
        if (!sel) throw new Error("selector required");
        const rows = await page.evaluate(
          ({ sel, attr, limit }) => {
            const out = [];
            document.querySelectorAll(sel).forEach((el, i) => {
              if (i >= limit) return;
              const v = attr ? el.getAttribute(attr) : (el.innerText || el.textContent || "").trim();
              if (v) out.push(v.replace(/\s+/g, " ").slice(0, 300));
            });
            return out;
          },
          { sel, attr: args.attr || null, limit: Math.min(Number(args.limit) || 60, 200) }
        );
        out.text = rows.length ? rows.map((r, i) => `${i + 1}. ${r}`).join("\n") : "No matches.";
        break;
      }

      case "extract_json": {
        const rowSel = args.rows || args.rowSelector;
        if (!rowSel) throw new Error("rows selector chahiye (jaise 'tr', '.item')");
        const fields = args.fields || {};
        const limit = Math.min(Number(args.limit) || 50, 300);
        const data = await page.evaluate(
          ({ rowSel, fields, limit }) => {
            const rows = [...document.querySelectorAll(rowSel)].slice(0, limit);
            return rows.map((row) => {
              const obj = {};
              for (const [key, sel] of Object.entries(fields)) {
                const el = sel === "@text" ? row : row.querySelector(sel);
                if (!el) {
                  obj[key] = null;
                  continue;
                }
                if (sel.includes("@href")) obj[key] = el.getAttribute("href") || el.href;
                else if (sel.includes("@src")) obj[key] = el.getAttribute("src");
                else obj[key] = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
              }
              return obj;
            });
          },
          { rowSel, fields, limit }
        );
        const clean = data.filter((r) => Object.values(r).some((v) => v));
        out.text =
          `Structured data (${clean.length} rows):\n` +
          JSON.stringify(clean, null, 2).slice(0, 7000) +
          `\n\nTIP: save_results({filename:"data.json", content: <ye JSON>}) se file banao.`;
        break;
      }

      case "extract_links": {
        const sel = args.selector || "a";
        const limit = Math.min(Number(args.limit) || 40, 200);
        const rows = await page.evaluate(
          ({ sel, limit }) => {
            const out = [];
            const seen = new Set();
            document.querySelectorAll(sel).forEach((a) => {
              if (out.length >= limit) return;
              const text = (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim();
              const href = a.href || "";
              if (!href || href.startsWith("javascript:")) return;
              const key = text + "|" + href;
              if (seen.has(key)) return;
              seen.add(key);
              out.push({ text: text.slice(0, 120), href });
            });
            return out;
          },
          { sel, limit }
        );
        out.text = rows.length
          ? "Links (text — absolute URL):\n" + rows.map((r, i) => `${i + 1}. ${r.text || "(no text)"} — ${r.href}`).join("\n")
          : "Koi link nahi mila.";
        break;
      }

      case "tabs": {
        const ctx = await this.ensure();
        const action = args.action || "list";
        if (action === "new") {
          const p = await ctx.newPage();
          this.activePage = p;
          await this.trimTabs(8);
          if (args.url) {
            try {
              await p.goto(assertSafeUrl(args.url), { waitUntil: "domcontentloaded" });
            } catch {}
          }
          out.text = `Opened new tab (${ctx.pages().length} tabs). URL: ${p.url()}`;
        } else if (action === "switch") {
          const idx = Number(args.index) || 0;
          const p = ctx.pages()[idx];
          if (!p) throw new Error(`No tab at index ${idx}`);
          await p.bringToFront();
          this.activePage = p;
          out.text = `Switched to tab ${idx}: ${p.url()}`;
        } else if (action === "close") {
          const idx = Number(args.index);
          const p = ctx.pages()[idx];
          if (p) await p.close();
          if (this.activePage?.isClosed()) this.activePage = null;
          out.text = `Closed tab ${idx}. ${ctx.pages().length} tabs remain.`;
        } else {
          out.text = ctx
            .pages()
            .map((p, i) => `[${i}] ${p.url()}`)
            .join("\n");
        }
        break;
      }

      case "screenshot": {
        const name = args.name ? String(args.name).replace(/[^\w.-]/g, "_") : `shot-${Date.now()}`;
        const file = path.join(OUTPUTS, name.endsWith(".jpg") ? name : `${name}.jpg`);
        const dims = await page
          .evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }))
          .catch(() => ({ w: 1366, h: 900 }));
        const MAX_H = 16000; // bahut lambi page = OOM
        const clipH = Math.min(dims.h, MAX_H);
        const buf = await page.screenshot({
          type: "jpeg",
          quality: args.fullPage ? 45 : 60,
          ...(args.fullPage ? { clip: { x: 0, y: 0, width: dims.w, height: clipH } } : {}),
        });
        fs.writeFileSync(file, buf);
        out.text =
          `Capture saved: outputs/${path.basename(file)} (${Math.round(buf.length / 1024)}KB, ${dims.w}x${clipH}px)` +
          (dims.h > MAX_H ? ` — page ${dims.h}px tha, upar ${MAX_H}px liya` : "");
        out.images.push({ mimeType: "image/jpeg", data: buf.toString("base64") });
        break;
      }

      case "capture": {
        // poore page ka proof screenshot — Files tab me download ke liye
        const name = String(args.name || `capture-${Date.now()}`).replace(/[^\w.-]/g, "_");
        const file = path.join(OUTPUTS, name.endsWith(".jpg") ? name : `${name}.jpg`);
        const dims = await page
          .evaluate(() => ({
            w: Math.min(document.documentElement.scrollWidth, 2000),
            h: document.documentElement.scrollHeight,
          }))
          .catch(() => ({ w: 1366, h: 900 }));
        const MAX_H = 16000;
        const clipH = Math.min(dims.h, MAX_H);
        const buf = await page.screenshot({
          type: "jpeg",
          quality: 45,
          clip: { x: 0, y: 0, width: dims.w, height: clipH },
        });
        fs.writeFileSync(file, buf);
        out.text = `📸 Capture saved: outputs/${path.basename(file)} (${Math.round(buf.length / 1024)}KB, full page ${dims.w}x${clipH})`;
        out.images.push({ mimeType: "image/jpeg", data: buf.toString("base64") });
        break;
      }

      case "save_results": {
        const rawName = String(args.filename || `result-${crypto.randomUUID().slice(0, 8)}`).replace(
          /[^\w.\-]/g,
          "_"
        );
        const file = path.join(OUTPUTS, rawName.includes(".") ? rawName : `${rawName}.md`);
        fs.writeFileSync(file, String(args.content ?? ""));
        out.text = `Saved to outputs/${path.basename(file)} (${String(args.content ?? "").length} chars)`;
        break;
      }

      case "save_field": {
        const k = String(args.key || "").trim();
        if (!k) throw new Error("key required");
        this.board.set(k, String(args.value ?? "").slice(0, 20000));
        out.text = `Board me save: "${k}" = ${String(args.value ?? "").slice(0, 120)}${String(args.value ?? "").length > 120 ? "…" : ""}\nBoard me ab ${this.board.size} fields hain.`;
        break;
      }

      case "get_field": {
        const k = String(args.key || "").trim();
        if (!k) throw new Error("key required");
        const v = this.board.get(k);
        out.text = v === undefined ? `"${k}" board me nahi hai. Available: ${[...this.board.keys()].join(", ") || "(khaali)"}` : `${k} = ${v}`;
        break;
      }

      case "list_fields": {
        if (!this.board.size) {
          out.text = "Board khaali hai. Pehle save_field se data daalo.";
        } else {
          out.text = [...this.board.entries()]
            .map(([k, v]) => `- ${k} = ${String(v).replace(/\s+/g, " ").slice(0, 140)}${String(v).length > 140 ? "…" : ""}`)
            .join("\n");
        }
        break;
      }

      case "note": {
        this.notes.push(String(args.text || ""));
        out.text = `Note stored (${this.notes.length} notes on scratchpad).`;
        break;
      }

      case "read_notes": {
        out.text = this.notes.length ? this.notes.map((n, i) => `${i + 1}. ${n}`).join("\n") : "(scratchpad empty)";
        break;
      }

      case "copy": {
        // page ka text clipboard me copy (tab A → tab B ke liye)
        if (args.selector) {
          const loc = page.locator(args.selector).first();
          await loc.click({ timeout: 8000 }).catch(() => {});
          await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
        } else {
          await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
        }
        await page.waitForTimeout(150);
        await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+C");
        await page.waitForTimeout(200);
        let copied = "";
        try {
          copied = await page.evaluate(() => navigator.clipboard.readText());
        } catch {}
        out.text = `Clipboard me copy ho gaya (${copied.length} chars).\nPreview: ${copied.slice(0, 300)}`;
        break;
      }

      case "paste": {
        await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
        await this.settle(page);
        out.text = `Paste kar diya.\n${await this.snapshot(page)}`;
        break;
      }

      case "click_at": {
        // screenshot dekh kar coordinate pe click — jab DOM se kaam na chale
        const x = Number(args.x);
        const y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x aur y coordinates chahiye");
        await page.mouse.click(x, y);
        await page.waitForTimeout(600);
        out.text = `(${x}, ${y}) pe click kiya.\n${await this.snapshot(page)}`;
        break;
      }

      case "type_at": {
        const x = Number(args.x);
        const y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x aur y coordinates chahiye");
        await page.mouse.click(x, y);
        await page.waitForTimeout(250);
        await page.keyboard.type(String(args.text ?? ""), { delay: 25 });
        if (args.submit) {
          await page.keyboard.press("Enter");
          await this.settle(page);
        }
        out.text = `(${x}, ${y}) pe click karke likha: "${String(args.text ?? "").slice(0, 40)}"\n${await this.snapshot(page)}`;
        break;
      }

      case "scroll_to": {
        const target = String(args.text || "");
        const loc = await this.resolveLocator(page, { text: target, selector: args.selector });
        if (!(await loc.count().catch(() => 0))) throw new Error(`"${target}" page pe nahi mila`);
        await loc.scrollIntoViewIfNeeded({ timeout: 10000 });
        await page.waitForTimeout(400);
        const box = await loc.boundingBox().catch(() => null);
        out.text = `"${target}" tak scroll kiya${box ? ` (position ${Math.round(box.x)},${Math.round(box.y)})` : ""}.\n${await this.snapshot(page)}`;
        break;
      }

      case "captcha": {
        const cap = await this.detectCaptcha(page);
        if (!cap.found) {
          out.text = "Page pe captcha nahi hai — normal kaam continue karo.";
          break;
        }
        // 1. andar ka checkbox click karne ki koshish (kuch cases me kaam karta hai)
        let tried = false;
        for (const f of page.frames()) {
          try {
            const box = f.locator('input[type="checkbox"], .recaptcha-checkbox, #challenge-stage input').first();
            if (await box.count()) {
              await box.click({ timeout: 4000 });
              tried = true;
              break;
            }
          } catch {}
        }
        if (tried) await page.waitForTimeout(2500);
        const after = await this.detectCaptcha(page);
        if (!after.found) {
          out.text = `Captcha clear ho gaya (${cap.type}) — kaam continue karo.\n${await this.snapshot(page)}`;
          break;
        }
        out.text =
          `⚠️ CAPTCHA (${cap.type}) — solve nahi kar sakta.\n` +
          `Ab ye karo (is order me):\n` +
          `1. 10-20 second wait karke read_page() — kai baar khud clear ho jata hai\n` +
          `2. Doosra source: search() se wahi info kisi aur site se lo\n` +
          `3. Google cache / archive.org version try karo\n` +
          `4. Headless=false (local) me user khud solve kar sakta hai — wait_for_human() use karo\n` +
          `5. Kabhi bhi bypass/solver service mat try karo`;
        break;
      }

      case "wait_for_human": {
        const maxSec = Math.min(Number(args.seconds) || 120, 600);
        out.text = `Insaan ke solve karne ka intezaar (max ${maxSec}s)…`;
        const start = Date.now();
        let cleared = false;
        while (Date.now() - start < maxSec * 1000) {
          await page.waitForTimeout(3000);
          const c = await this.detectCaptcha(page);
          if (!c.found) {
            cleared = true;
            break;
          }
        }
        out.text = cleared
          ? `Captcha clear ho gaya (${Math.round((Date.now() - start) / 1000)}s) — continue karo.\n${await this.snapshot(page)}`
          : `Abhi bhi captcha hai (${maxSec}s baad bhi) — doosra source try karo ya task adhoora report karo.`;
        break;
      }

      case "finish": {
        out.text = "TASK_FINISHED";
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return out;
  }
}

// ── tool schema handed to Gemini ──────────────────────────────────────────────

export const TOOL_DECLARATIONS = [
  {
    name: "search",
    description:
      "Run a web search and get back a numbered list of results (title, url, snippet). Use this first for research instead of guessing URLs.",
    parameters: {
      type: "OBJECT",
      properties: { query: { type: "STRING" } },
      required: ["query"],
    },
  },
  {
    name: "navigate",
    description: "Open a URL in the browser and return the page snapshot.",
    parameters: {
      type: "OBJECT",
      properties: { url: { type: "STRING" } },
      required: ["url"],
    },
  },
  {
    name: "elements",
    description:
      "List the clickable/typable elements on the page with numeric indices. Call this before clicking so you can click by index.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "click",
    description: "Click an element. Give ONE of: index (from elements), text (visible label), or selector (CSS).",
    parameters: {
      type: "OBJECT",
      properties: {
        index: { type: "INTEGER" },
        text: { type: "STRING" },
        selector: { type: "STRING" },
      },
    },
  },
  {
    name: "type",
    description: "Type text into an input. Give ONE of index/text/selector. Set submit=true to press Enter after.",
    parameters: {
      type: "OBJECT",
      properties: {
        index: { type: "INTEGER" },
        text: { type: "STRING" },
        selector: { type: "STRING" },
        submit: { type: "BOOLEAN" },
      },
    },
  },
  {
    name: "hover",
    description: "Hover over an element (dropdown menus / tooltips jo hover pe khulte hain).",
    parameters: {
      type: "OBJECT",
      properties: { index: { type: "INTEGER" }, text: { type: "STRING" }, selector: { type: "STRING" } },
    },
  },
  {
    name: "select",
    description: "Choose an option in a <select> dropdown by visible label or value.",
    parameters: {
      type: "OBJECT",
      properties: {
        index: { type: "INTEGER" },
        text: { type: "STRING" },
        selector: { type: "STRING" },
        label: { type: "STRING" },
        value: { type: "STRING" },
      },
    },
  },
  {
    name: "check",
    description: "Check or uncheck a checkbox / radio button. Set checked=false to uncheck.",
    parameters: {
      type: "OBJECT",
      properties: {
        index: { type: "INTEGER" },
        text: { type: "STRING" },
        selector: { type: "STRING" },
        checked: { type: "BOOLEAN" },
      },
    },
  },
  {
    name: "fill_form",
    description:
      "Fill many fields in one call. fields = [{label|selector|index, value, kind: 'text'|'select'|'check'}]. " +
      "Much faster and more reliable than typing one by one.",
    parameters: {
      type: "OBJECT",
      properties: {
        fields: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              label: { type: "STRING" },
              selector: { type: "STRING" },
              index: { type: "INTEGER" },
              value: { type: "STRING" },
              kind: { type: "STRING" },
            },
          },
        },
      },
      required: ["fields"],
    },
  },
  {
    name: "extract_table",
    description: "Extract an HTML table as CSV text. Use for price tables, listings, schedules, results.",
    parameters: {
      type: "OBJECT",
      properties: { selector: { type: "STRING" }, limit: { type: "INTEGER" } },
    },
  },
  {
    name: "auto_scroll",
    description: "Scroll down repeatedly to load infinite-scroll / lazy-loaded content, then snapshot.",
    parameters: {
      type: "OBJECT",
      properties: { rounds: { type: "INTEGER" } },
    },
  },
  {
    name: "upload",
    description: "Attach a file to a file input. File must exist in the outputs/ folder.",
    parameters: {
      type: "OBJECT",
      properties: { selector: { type: "STRING" }, file: { type: "STRING" } },
      required: ["file"],
    },
  },
  {
    name: "download",
    description: "Click something that starts a download and save the file into outputs/.",
    parameters: {
      type: "OBJECT",
      properties: { index: { type: "INTEGER" }, text: { type: "STRING" }, selector: { type: "STRING" } },
    },
  },
  {
    name: "iframes",
    description: "List iframes on the page (forms often live inside iframes).",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "press",
    description: "Press a keyboard key on the page (Enter, Tab, Escape, ArrowDown...).",
    parameters: {
      type: "OBJECT",
      properties: { key: { type: "STRING" } },
      required: ["key"],
    },
  },
  {
    name: "scroll",
    description: "Scroll the page up or down.",
    parameters: {
      type: "OBJECT",
      properties: {
        direction: { type: "STRING", enum: ["up", "down"] },
        amount: { type: "INTEGER" },
      },
    },
  },
  {
    name: "back",
    description: "Browser back.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "forward",
    description: "Browser forward.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "wait",
    description: "Wait for a selector or a number of milliseconds (useful after slow loads).",
    parameters: {
      type: "OBJECT",
      properties: { ms: { type: "INTEGER" }, selector: { type: "STRING" } },
    },
  },
  {
    name: "read_page",
    description: "Get the full visible text of the current page (up to `limit` chars). Use for detailed reading.",
    parameters: {
      type: "OBJECT",
      properties: { limit: { type: "INTEGER" } },
    },
  },
  {
    name: "extract",
    description:
      "Extract all text (or an attribute like href/src) from every element matching a CSS selector. Best way to pull a list of items cheaply.",
    parameters: {
      type: "OBJECT",
      properties: {
        selector: { type: "STRING" },
        attr: { type: "STRING" },
        limit: { type: "INTEGER" },
      },
      required: ["selector"],
    },
  },
  {
    name: "extract_json",
    description:
      "Scrape a repeating list into clean JSON. Give rows (CSS for each row, e.g. 'tr' or '.product') and " +
      "fields mapping output keys to selectors inside the row, e.g. {name:'.title', price:'.price', link:'a@href'}. " +
      "Much more reliable than reading text for tables/lists.",
    parameters: {
      type: "OBJECT",
      properties: {
        rows: { type: "STRING" },
        fields: { type: "OBJECT" },
        limit: { type: "INTEGER" },
      },
      required: ["rows", "fields"],
    },
  },
  {
    name: "extract_links",
    description:
      "Get every link on the page as 'text — absolute URL' pairs. ALWAYS use this instead of guessing URLs " +
      "from visible text. Perfect for building lists of articles / products / results.",
    parameters: {
      type: "OBJECT",
      properties: { selector: { type: "STRING" }, limit: { type: "INTEGER" } },
    },
  },
  {
    name: "tabs",
    description: "Manage tabs: list, new (optional url), switch (by index), close (by index).",
    parameters: {
      type: "OBJECT",
      properties: {
        action: { type: "STRING", enum: ["list", "new", "switch", "close"] },
        url: { type: "STRING" },
        index: { type: "INTEGER" },
      },
    },
  },
  {
    name: "capture",
    description:
      "Take a FULL-PAGE screenshot and save it as proof/output. Give it a clear name like 'amazon_results'. " +
      "Files tab me download ke liye aa jayega. Use this before finishing when the user asked to see/show/prove something.",
    parameters: {
      type: "OBJECT",
      properties: { name: { type: "STRING" } },
    },
  },
  {
    name: "screenshot",
    description: "Take a screenshot you can see. Use when the page is confusing or a captcha/visual step appears.",
    parameters: {
      type: "OBJECT",
      properties: { fullPage: { type: "BOOLEAN" } },
    },
  },
  {
    name: "save_results",
    description:
      "Save the collected data to a file in the outputs folder. filename should include extension (.csv, .md, .json, .txt). Call this before finishing any research task.",
    parameters: {
      type: "OBJECT",
      properties: { filename: { type: "STRING" }, content: { type: "STRING" } },
      required: ["content"],
    },
  },
  {
    name: "save_field",
    description:
      "Save a value to the persistent task data board under a name, e.g. save_field(key='amazon_price', value='₹26,990'). " +
      "The board survives tab switches, model switches and phases — use it for every fact you will need later.",
    parameters: {
      type: "OBJECT",
      properties: { key: { type: "STRING" }, value: { type: "STRING" } },
      required: ["key", "value"],
    },
  },
  {
    name: "get_field",
    description: "Read one saved value from the data board by key.",
    parameters: {
      type: "OBJECT",
      properties: { key: { type: "STRING" } },
      required: ["key"],
    },
  },
  {
    name: "list_fields",
    description: "List everything on the data board (all saved key/value pairs).",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "note",
    description: "Store a progress note on the scratchpad so long tasks do not lose data across steps.",
    parameters: {
      type: "OBJECT",
      properties: { text: { type: "STRING" } },
      required: ["text"],
    },
  },
  {
    name: "read_notes",
    description: "Read everything saved on the scratchpad.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "copy",
    description:
      "Copy text to the clipboard: whole page, or from a CSS selector. Use with paste() to move data between tabs.",
    parameters: {
      type: "OBJECT",
      properties: { selector: { type: "STRING" } },
    },
  },
  {
    name: "paste",
    description: "Paste the clipboard into the focused input on the current tab.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "click_at",
    description:
      "Click at exact viewport coordinates (x, y). Use this when the page is a canvas / custom UI / shadow DOM " +
      "and elements() does not show what you need: take screenshot(), look at it, then click_at the right spot. " +
      "Coordinates are in CSS pixels of the 1366x900 viewport — the screenshot is that same view.",
    parameters: {
      type: "OBJECT",
      properties: { x: { type: "INTEGER" }, y: { type: "INTEGER" } },
      required: ["x", "y"],
    },
  },
  {
    name: "type_at",
    description: "Click at (x, y) and type text there. Use for visual UIs where selectors do not work.",
    parameters: {
      type: "OBJECT",
      properties: {
        x: { type: "INTEGER" },
        y: { type: "INTEGER" },
        text: { type: "STRING" },
        submit: { type: "BOOLEAN" },
      },
      required: ["x", "y", "text"],
    },
  },
  {
    name: "scroll_to",
    description: "Scroll an element (by visible text or CSS selector) into view before clicking it.",
    parameters: {
      type: "OBJECT",
      properties: { text: { type: "STRING" }, selector: { type: "STRING" } },
    },
  },
  {
    name: "captcha",
    description:
      "Check whether the page has a CAPTCHA / bot-check and try the one legitimate move (click its checkbox). " +
      "Returns next steps. Call this when a page looks like a 'verify you are human' / 'just a moment' screen.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "wait_for_human",
    description:
      "Wait up to N seconds while a human solves the CAPTCHA in a visible (non-headless) browser. " +
      "Only useful in local runs with HEADLESS=false.",
    parameters: { type: "OBJECT", properties: { seconds: { type: "INTEGER" } } },
  },
  {
    name: "finish",
    description: "End the task. Call this only when the goal is fully done or genuinely impossible.",
    parameters: {
      type: "OBJECT",
      properties: { summary: { type: "STRING" } },
      required: ["summary"],
    },
  },
];
