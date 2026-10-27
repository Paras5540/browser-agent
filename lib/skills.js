// Site skills: har domain ke liye seekhi hui baatein (login flow, URL patterns, selectors).
// Agli baar us site pe jaate hi agent ko yaad rehta hai — dobara try-catch nahi karna padta.
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve("./skills");

function safe(host) {
  return String(host || "")
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9.-]/g, "_")
    .slice(0, 80);
}

export function loadSkill(urlOrHost) {
  try {
    const host = /^https?:/.test(urlOrHost) ? new URL(urlOrHost).hostname : urlOrHost;
    const file = path.join(DIR, `${safe(host)}.md`);
    if (!fs.existsSync(file)) return "";
    const txt = fs.readFileSync(file, "utf8");
    return txt.slice(-2500);
  } catch {
    return "";
  }
}

export function saveSkill(urlOrHost, note) {
  try {
    const host = /^https?:/.test(urlOrHost) ? new URL(urlOrHost).hostname : urlOrHost;
    fs.mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, `${safe(host)}.md`);
    const stamp = new Date().toISOString().slice(0, 10);
    const entry = `\n- ${stamp}: ${String(note).replace(/\s+/g, " ").slice(0, 300)}`;
    if (fs.existsSync(file)) {
      const txt = fs.readFileSync(file, "utf8");
      if (txt.length > 20_000) {
        fs.writeFileSync(file, `# ${safe(host)} — site notes\n` + entry.slice(-0, 0) + txt.slice(-8000));
      } else {
        fs.appendFileSync(file, entry);
      }
    } else {
      fs.writeFileSync(file, `# ${safe(host)} — site notes\n${entry}`);
    }
    return true;
  } catch {
    return false;
  }
}

export function listSkills() {
  try {
    return fs.readdirSync(DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}
