// Playwright wrapper + the actual tool implementations the LLM can call.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const OUTPUTS = path.resolve("./outputs");
fs.mkdirSync(OUTPUTS, { recursive: true });

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class BrowserManager {
  constructor({ userDataDir, headless }) {
    this.userDataDir = path.resolve(userDataDir || "./data/browser-profile");
    this.forceHeadless = headless; // undefined = .env / UI setting se padho
    this.context = null;
    this.activePage = null;
    this.lastElements = [];
    this.notes = [];
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
    return this.context;
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

  async snapshot(page, { maxText = 3500 } = {}) {
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

    return [
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
      return page.getByText(text, { exact: false }).first();
    }
    if (selector) return page.locator(selector).first();
    throw new Error("Provide one of: index, text, selector");
  }

  // ── tool dispatch ──────────────────────────────────────────────────────────

  async runTool(name, args = {}) {
    const page = await this.page();
    const out = { text: "", images: [] };

    switch (name) {
      case "navigate": {
        await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await this.settle(page);
        out.text = `Navigated.\n${await this.snapshot(page)}`;
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
        const loc = await this.resolveLocator(page, args);
        if (!(await loc.count().catch(() => 0))) throw new Error("Element not found for click");
        await loc.click({ timeout: 20000 });
        await this.settle(page);
        out.text = `Clicked.\n${await this.snapshot(page)}`;
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
        const limit = Math.min(Number(args.limit) || 6000, 20000);
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

      case "tabs": {
        const ctx = await this.ensure();
        const action = args.action || "list";
        if (action === "new") {
          const p = await ctx.newPage();
          this.activePage = p;
          if (args.url) await p.goto(args.url, { waitUntil: "domcontentloaded" }).catch(() => {});
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
        const file = path.join(OUTPUTS, `shot-${Date.now()}.png`);
        const buf = await page.screenshot({ fullPage: !!args.fullPage });
        fs.writeFileSync(file, buf);
        out.text = `Screenshot saved: outputs/${path.basename(file)}`;
        out.images.push({ mimeType: "image/png", data: buf.toString("base64") });
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

      case "note": {
        this.notes.push(String(args.text || ""));
        out.text = `Note stored (${this.notes.length} notes on scratchpad).`;
        break;
      }

      case "read_notes": {
        out.text = this.notes.length ? this.notes.map((n, i) => `${i + 1}. ${n}`).join("\n") : "(scratchpad empty)";
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
    name: "finish",
    description: "End the task. Call this only when the goal is fully done or genuinely impossible.",
    parameters: {
      type: "OBJECT",
      properties: { summary: { type: "STRING" } },
      required: ["summary"],
    },
  },
];
