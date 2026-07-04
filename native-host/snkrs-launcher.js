#!/usr/bin/env node
// ============================================================
// Nike SNKRS Bot – Native Messaging Host ("the launcher")
// ============================================================
// A Chrome extension cannot, on its own, open a DIFFERENT Chrome
// profile — there is no chrome.* API for it. This tiny helper is the
// bridge: the dashboard (and the background worker) talk to it over
// Chrome Native Messaging, and it does the things only a local program
// can do:
//
//   • launch  Chrome at a URL using --profile-directory=<dir>
//   • listProfiles  read the installed Chrome profiles + their names
//   • getConfig / setConfig  read & write ONE shared config file
//                            (~/.snkrs-bot/config.json) — the "generic
//                            file" that holds the central drop + card
//                            details every account uses.
//
// Native Messaging framing: each message is a 4-byte little-endian
// uint32 length prefix followed by that many bytes of UTF-8 JSON, over
// stdin/stdout. We read in a loop so a single connectNative() port can
// issue many commands.
// ============================================================

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const HOST_VERSION = "1.2.0";

// ── Shared config file ("the generic file") ───────────────────
const CONFIG_DIR = path.join(os.homedir(), ".snkrs-bot");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
// Shared orders file. The orders page runs inside each account's OWN Chrome
// profile, whose chrome.storage.local the dashboard (a different profile)
// cannot see. So scraped orders are routed here, on disk, where any profile
// can read them — the same cross-profile trick the config uses.
const ORDERS_PATH = path.join(CONFIG_DIR, "orders.json");
// Shared LIVE STATUS — one small file PER PROFILE under ~/.snkrs-bot/status/.
// Per-profile files avoid the read-modify-write races you'd get if every
// profile hammered a single shared status.json (last writer would clobber the
// others). The dashboard aggregates them by reading the folder.
const STATUS_DIR = path.join(CONFIG_DIR, "status");
function statusFileFor(profileDir) {
  const safe = String(profileDir).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return path.join(STATUS_DIR, `s_${safe}.json`);
}

function readJsonFile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return null; // not created yet
  }
}

function writeJsonFile(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch (e) {}
}

function readConfig() { return readJsonFile(CONFIG_PATH); }
function writeConfig(config) { writeJsonFile(CONFIG_PATH, config); }

function readOrders() { return readJsonFile(ORDERS_PATH) || {}; }
// Merge one profile's order entry into the shared map. The caller
// (background.js) has already accumulated/deduped the entry, so we just store
// it under its profileDir.
function setOrdersEntry(profileDir, entry) {
  const map = readOrders();
  map[profileDir] = entry;
  writeJsonFile(ORDERS_PATH, map);
  return map;
}

function setStatusEntry(profileDir, entry) {
  // Store profileDir inside the record so the aggregator can key by it
  // regardless of how the filename was sanitised.
  writeJsonFile(statusFileFor(profileDir), Object.assign({}, entry, { profileDir }));
}
function readStatus() {
  const map = {};
  try {
    for (const f of fs.readdirSync(STATUS_DIR)) {
      if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
      const rec = readJsonFile(path.join(STATUS_DIR, f));
      if (!rec) continue;
      // Derive an id from the filename so entries from OLDER extension builds
      // (which didn't stamp key/profileDir into the record) still show up.
      const derived = f.replace(/^s_/, "").replace(/\.json$/, "");
      if (!rec.profileDir) rec.profileDir = derived; // lets the dashboard group it
      const k = rec.key || rec.profileDir || derived;
      map[k] = rec;
    }
  } catch (e) { /* dir not created yet */ }
  return map;
}
// ── Per-profile extension VERSION reports ─────────────────────
// Each profile's background worker reports its running extension version
// here on startup/boot. The dashboard compares these against the repo's
// manifest version ("latest") to flag stale profiles in its banner and on
// the Preflight page.
const VERSIONS_PATH = path.join(CONFIG_DIR, "versions.json");
function readVersions() { return readJsonFile(VERSIONS_PATH) || {}; }
function setVersionEntry(profileDir, entry) {
  const map = readVersions();
  map[profileDir] = entry;
  writeJsonFile(VERSIONS_PATH, map);
}

// The repo's manifest is the "latest available" version — the update server
// packs exactly this folder, so it is what every profile should be running.
function latestExtensionVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, "manifest.json"), "utf8")).version || "";
  } catch (e) { return ""; }
}

// ── Per-profile PREFLIGHT results ─────────────────────────────
// Same one-file-per-profile pattern as status/, for the same reason: the
// checks run inside each profile's own Chrome, and the dashboard (another
// profile) aggregates by reading the folder.
const PREFLIGHT_DIR = path.join(CONFIG_DIR, "preflight");
function preflightFileFor(profileDir) {
  const safe = String(profileDir).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return path.join(PREFLIGHT_DIR, `p_${safe}.json`);
}
function setPreflightEntry(profileDir, entry) {
  writeJsonFile(preflightFileFor(profileDir), Object.assign({}, entry, { profileDir }));
}
function readPreflight() {
  const map = {};
  try {
    for (const f of fs.readdirSync(PREFLIGHT_DIR)) {
      if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
      const rec = readJsonFile(path.join(PREFLIGHT_DIR, f));
      if (!rec) continue;
      const derived = f.replace(/^p_/, "").replace(/\.json$/, "");
      if (!rec.profileDir) rec.profileDir = derived;
      map[rec.profileDir] = rec;
    }
  } catch (e) { /* dir not created yet */ }
  return map;
}
function clearPreflight() {
  try {
    for (const f of fs.readdirSync(PREFLIGHT_DIR)) {
      if (f.endsWith(".json")) { try { fs.unlinkSync(path.join(PREFLIGHT_DIR, f)); } catch (e) {} }
    }
  } catch (e) {}
}

// ── Per-tab checkout TIMELINE (drop replay / analytics) ───────
// One file per key (profileDir#tabId), holding the ordered checkout events
// (started→loaded→filled→submitted→done/error) with timestamps + the drop
// time, so the dashboard can render a per-account timeline and compute how
// many ms before/after go-live each submit landed. Same per-profile-file
// pattern as status/, for the same cross-profile-visibility reason.
const TIMELINE_DIR = path.join(CONFIG_DIR, "timeline");
function timelineFileFor(key) {
  const safe = String(key).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 90);
  return path.join(TIMELINE_DIR, `tl_${safe}.json`);
}
function setTimelineEntry(key, entry) {
  writeJsonFile(timelineFileFor(key), Object.assign({}, entry, { key }));
}
function readTimeline() {
  const map = {};
  try {
    for (const f of fs.readdirSync(TIMELINE_DIR)) {
      if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
      const rec = readJsonFile(path.join(TIMELINE_DIR, f));
      if (!rec) continue;
      const k = rec.key || f.replace(/^tl_/, "").replace(/\.json$/, "");
      map[k] = rec;
    }
  } catch (e) { /* dir not created yet */ }
  return map;
}
function clearTimeline() {
  try {
    for (const f of fs.readdirSync(TIMELINE_DIR)) {
      if (f.endsWith(".json")) { try { fs.unlinkSync(path.join(TIMELINE_DIR, f)); } catch (e) {} }
    }
  } catch (e) {}
}

function clearStatus(profileDir) {
  try {
    for (const f of fs.readdirSync(STATUS_DIR)) {
      if (!f.endsWith(".json")) continue;
      if (!profileDir) { try { fs.unlinkSync(path.join(STATUS_DIR, f)); } catch (e) {} continue; }
      // Remove every tab-file that belongs to this profile.
      const rec = readJsonFile(path.join(STATUS_DIR, f));
      if (rec && rec.profileDir === profileDir) { try { fs.unlinkSync(path.join(STATUS_DIR, f)); } catch (e) {} }
    }
  } catch (e) {}
}

// ── Locate Chrome ─────────────────────────────────────────────
// Overridable with env vars so unusual installs still work:
//   SNKRS_CHROME_PATH           — full path to the chrome executable
//   SNKRS_CHROME_USER_DATA_DIR  — Chrome's "User Data" directory
function chromeCandidates() {
  if (process.env.SNKRS_CHROME_PATH) return [process.env.SNKRS_CHROME_PATH];
  const platform = process.platform;
  if (platform === "win32") {
    const pf = process.env["ProgramFiles"] || "C:\\Program Files";
    const pfx86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"] || path.join(os.homedir(), "AppData", "Local");
    return [
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pfx86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    ];
  }
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
    ];
  }
  // linux
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
}

function findChrome() {
  for (const c of chromeCandidates()) {
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  return null;
}

function userDataDir() {
  if (process.env.SNKRS_CHROME_USER_DATA_DIR) return process.env.SNKRS_CHROME_USER_DATA_DIR;
  const platform = process.platform;
  if (platform === "win32") {
    const local = process.env["LOCALAPPDATA"] || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "Google", "Chrome", "User Data");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  }
  return path.join(os.homedir(), ".config", "google-chrome");
}

// Read Chrome's "Local State" to enumerate profiles + their display names.
function listProfiles() {
  const localState = path.join(userDataDir(), "Local State");
  let info = {};
  try {
    const raw = fs.readFileSync(localState, "utf8");
    info = (JSON.parse(raw).profile || {}).info_cache || {};
  } catch (e) {
    return []; // can't read — caller will show a manual-entry hint
  }
  return Object.keys(info).map((dir) => ({
    dir,
    name: info[dir].name || dir,
    active: info[dir].active_time || 0,
  })).sort((a, b) => (b.active || 0) - (a.active || 0));
}

// Extension folder is the parent of this native-host directory. We expose it
// in the ping response for diagnostics, but we deliberately DO NOT pass it via
// --load-extension when launching profiles (see below).
const EXTENSION_DIR = path.resolve(__dirname, "..");

// Accepts a single url (string) OR many (array). Passing multiple URLs to one
// chrome invocation opens them all as tabs in that profile — reliably, even
// when the profile's Chrome is cold-starting (separate rapid launches can race
// and get dropped, which is why multi-product only opened one tab).
function launchProfile(profileDir, urlOrUrls, extensionDir) {
  const chrome = findChrome();
  if (!chrome) {
    return { ok: false, error: "Chrome executable not found. Set SNKRS_CHROME_PATH." };
  }
  if (!profileDir) return { ok: false, error: "Missing profileDir." };

  // IMPORTANT: we intentionally do NOT pass --load-extension.
  // Chrome 137+ treats any session started with --load-extension as untrusted
  // and DISABLES all developer-mode (unpacked) extensions in it — including the
  // copy the user installed manually. That made bot-launched profiles open with
  // NO extension, even though manual launches worked. Launching without the flag
  // lets each profile load its own already-installed extension normally.
  const args = [`--profile-directory=${profileDir}`];
  const urls = Array.isArray(urlOrUrls) ? urlOrUrls : (urlOrUrls ? [urlOrUrls] : []);
  for (const u of urls) if (u) args.push(u);

  try {
    const child = spawn(chrome, args, { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, pid: child.pid, chrome, tabs: urls.length };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// ── Command dispatch ──────────────────────────────────────────
function handle(msg) {
  const cmd = msg && msg.cmd;
  switch (cmd) {
    case "ping":
      return {
        ok: true,
        version: HOST_VERSION,
        platform: process.platform,
        chrome: findChrome(),
        userDataDir: userDataDir(),
        configPath: CONFIG_PATH,
        extensionDir: EXTENSION_DIR,
        latestVersion: latestExtensionVersion(),
      };
    case "listProfiles":
      return { ok: true, profiles: listProfiles() };
    case "getConfig":
      return { ok: true, config: readConfig() };
    case "setConfig":
      try {
        writeConfig(msg.config || {});
        return { ok: true, configPath: CONFIG_PATH };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    case "launch":
      return launchProfile(msg.profileDir, msg.urls || msg.url, msg.extensionDir);
    case "getOrders":
      return { ok: true, orders: readOrders() };
    case "setOrders":
      if (!msg.profileDir) return { ok: false, error: "Missing profileDir." };
      try {
        setOrdersEntry(msg.profileDir, msg.entry || {});
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    case "clearOrders":
      try {
        if (msg.profileDir) {
          const map = readOrders();
          delete map[msg.profileDir];
          writeJsonFile(ORDERS_PATH, map);
        } else {
          writeJsonFile(ORDERS_PATH, {});
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    case "reportVersion":
      if (!msg.profileDir) return { ok: false, error: "Missing profileDir." };
      try {
        setVersionEntry(msg.profileDir, msg.entry || {});
        return { ok: true, latestVersion: latestExtensionVersion() };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    case "getVersions":
      return { ok: true, versions: readVersions(), latestVersion: latestExtensionVersion() };
    case "setPreflight":
      if (!msg.profileDir) return { ok: false, error: "Missing profileDir." };
      try {
        setPreflightEntry(msg.profileDir, msg.entry || {});
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    case "getPreflight":
      return { ok: true, preflight: readPreflight(), latestVersion: latestExtensionVersion() };
    case "clearPreflight":
      try {
        clearPreflight();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    case "setTimeline":
      if (!msg.profileDir) return { ok: false, error: "Missing key." };
      try {
        setTimelineEntry(msg.profileDir, msg.entry || {});
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    case "getTimeline":
      return { ok: true, timeline: readTimeline() };
    case "clearTimeline":
      try {
        clearTimeline();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    case "getStatus":
      return { ok: true, status: readStatus() };
    case "setStatus":
      if (!msg.profileDir) return { ok: false, error: "Missing profileDir." };
      try {
        setStatusEntry(msg.profileDir, msg.entry || {});
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    case "clearStatus":
      try {
        clearStatus(msg.profileDir);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    default:
      return { ok: false, error: `Unknown cmd: ${cmd}` };
  }
}

// ── Native Messaging I/O (length-prefixed JSON over stdio) ─────
function sendMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(header);
  process.stdout.write(json);
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  // Drain as many complete messages as we have.
  while (buffer.length >= 4) {
    const len = buffer.readUInt32LE(0);
    if (buffer.length < 4 + len) break;
    const body = buffer.slice(4, 4 + len);
    buffer = buffer.slice(4 + len);
    let response;
    try {
      response = handle(JSON.parse(body.toString("utf8")));
    } catch (e) {
      response = { ok: false, error: "Bad request: " + String(e && e.message || e) };
    }
    sendMessage(response);
  }
});

// When Chrome closes the port, stdin ends — exit cleanly.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
