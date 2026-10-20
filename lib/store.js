// Tiny JSON-file store. No DB to install, easy to inspect/backup.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DB_PATH = path.resolve("./data/db.json");

const EMPTY = {
  runs: [], // { id, goal, status, source, log[], result, error, createdAt, finishedAt, scheduleId }
  schedules: [], // { id, name, goal, cron, enabled, lastRun, lastStatus }
  settings: { headless: null, maxSteps: null },
};

function read() {
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return { ...structuredClone(EMPTY), ...parsed };
  } catch {
    return structuredClone(EMPTY);
  }
}

// Atomic-ish write: write temp then rename, so a crash can't corrupt the db.
function write(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

export const store = {
  all: read,

  getRun(id) {
    return read().runs.find((r) => r.id === id) || null;
  },

  createRun({ goal, source = "chat", scheduleId = null }) {
    const db = read();
    const run = {
      id: crypto.randomUUID(),
      goal,
      source,
      scheduleId,
      status: "running",
      log: [],
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };
    db.runs.unshift(run);
    db.runs = db.runs.slice(0, 200); // keep last 200 runs
    write(db);
    return run;
  },

  updateRun(id, patch) {
    const db = read();
    const i = db.runs.findIndex((r) => r.id === id);
    if (i === -1) return null;
    db.runs[i] = { ...db.runs[i], ...patch };
    write(db);
    return db.runs[i];
  },

  appendLog(id, entry) {
    const db = read();
    const r = db.runs.find((x) => x.id === id);
    if (!r) return;
    r.log.push({ t: Date.now(), ...entry });
    if (r.log.length > 400) r.log = r.log.slice(-400);
    write(db);
  },

  listSchedules() {
    return read().schedules;
  },

  createSchedule({ name, goal, cron }) {
    const db = read();
    const s = {
      id: crypto.randomUUID(),
      name,
      goal,
      cron,
      enabled: true,
      lastRun: null,
      lastStatus: null,
      createdAt: new Date().toISOString(),
    };
    db.schedules.push(s);
    write(db);
    return s;
  },

  updateSchedule(id, patch) {
    const db = read();
    const i = db.schedules.findIndex((s) => s.id === id);
    if (i === -1) return null;
    db.schedules[i] = { ...db.schedules[i], ...patch };
    write(db);
    return db.schedules[i];
  },

  deleteSchedule(id) {
    const db = read();
    db.schedules = db.schedules.filter((s) => s.id !== id);
    write(db);
  },

  getSettings() {
    return read().settings;
  },

  setSettings(patch) {
    const db = read();
    db.settings = { ...db.settings, ...patch };
    write(db);
    return db.settings;
  },
};
