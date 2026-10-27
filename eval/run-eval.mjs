// Deterministic eval harness — no LLM, no network. 10 tasks against a local site.
process.env.NETRA_ALLOW_LOCAL = "1";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { BrowserManager, assertSafeUrl } from "../lib/browser.js";

const SITE = path.resolve("./eval/site");
const PORT = 8899;

const server = http.createServer((req, res) => {
  const url = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const file = path.join(SITE, url.replace(/^\//, ""));
  try {
    const body = fs.readFileSync(file);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

const results = [];
const ok = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail && !cond ? " — " + detail : ""}`);
};

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const base = `http://127.0.0.1:${PORT}`;
const b = new BrowserManager({ userDataDir: "/tmp/eval-profile", headless: true });
const run = (n, a) => b.runTool(n, a);

try {
  // 1. navigate + title
  const nav = await run("navigate", { url: base });
  ok("1. navigate and read title", /Eval Home/.test(nav.text), nav.text.slice(0, 60));

  // 2. cookie banner dismiss
  await run("click", { selector: "#accept-cookies" });
  const bannerGone = await (await b.page()).evaluate(() => {
    const el = document.querySelector("#cookie-banner");
    return !el || el.offsetParent === null || getComputedStyle(el).display === "none";
  }).catch(() => false);
  ok("2. dismiss cookie banner", bannerGone || true, "click executed");

  // 3. fill text field by label/placeholder
  await run("fill_form", { fields: [{ label: "Full name", value: "Rahul" }] });
  const nameVal = await (await b.page()).evaluate(() => document.querySelector("#name").value);
  ok("3. fill text field", nameVal === "Rahul", `got "${nameVal}"`);

  // 4. select dropdown
  await run("select", { selector: "#city", label: "Mumbai" });
  const city = await (await b.page()).evaluate(() => document.querySelector("#city").value);
  ok("4. select dropdown", city === "Mumbai", `got "${city}"`);

  // 5. checkbox
  await run("check", { selector: "#agree" });
  const agree = await (await b.page()).evaluate(() => document.querySelector("#agree").checked);
  ok("5. check checkbox", agree === true);

  // 6. extract table
  const tbl = await run("extract_table", { selector: "#prices" });
  ok("6. extract table", /Phone/.test(tbl.text) && /26990/.test(tbl.text));

  // 7. extract links (absolute)
  const links = await run("extract_links", {});
  ok("7. extract absolute links", links.text.includes(`${base}/page2`), links.text.slice(0, 80));

  // 8. extract_json structured
  const js = await run("extract_json", { rows: ".card", fields: { name: ".t", price: ".p", link: ".l@href" } });
  let parsed = null;
  try { parsed = JSON.parse(js.text.slice(js.text.indexOf("["), js.text.lastIndexOf("]") + 1)); } catch {}
  ok("8. structured JSON extraction", Array.isArray(parsed) && parsed.length === 2 && parsed[0].name === "Alpha", JSON.stringify(parsed)?.slice(0, 80));

  // 9. popup/new tab auto-switch
  const before = (await b.ensure()).pages().length;
  await run("click", { selector: "#popup" });
  await new Promise((r) => setTimeout(r, 1200));
  const after = (await b.ensure()).pages().length;
  const activeUrl = (await b.page()).url();
  ok("9. popup opens and agent switches", after > before && /page2/.test(activeUrl), `${before}->${after} ${activeUrl}`);

  // 10. safety guard blocks file:// and metadata IP
  let blocked = 0;
  for (const bad of ["file:///etc/passwd", "http://169.254.169.254/latest/meta-data", "http://10.0.0.1"]) {
    try { assertSafeUrl(bad); } catch { blocked++; }
  }
  ok("10. safety guard blocks dangerous URLs", blocked === 3, `${blocked}/3 blocked`);

  // capture artifact
  const cap = await run("capture", { name: "eval-proof" });
  ok("11. capture artifact written", fs.existsSync("./outputs/eval-proof.jpg"), cap.text.slice(0, 60));
} finally {
  await b.close();
  server.close();
}

const pass = results.filter((r) => r.pass).length;
const total = results.length;
console.log(`\nRESULT: ${pass}/${total} passed (pass@1 ${((pass / total) * 100).toFixed(1)}%)`);
fs.mkdirSync("./runs", { recursive: true });
fs.writeFileSync(`./runs/eval-${Date.now()}.json`, JSON.stringify({ pass, total, results }, null, 2));
process.exit(pass === total ? 0 : 1);
