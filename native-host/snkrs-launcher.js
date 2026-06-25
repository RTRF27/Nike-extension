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

const HOST_VERSION = "1.1.0";

// ── Shared config file ("the generic file") ───────────────────
const CONFIG_DIR = path.join(os.homedir(), ".snkrs-bot");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
// Shared orders file. The orders page runs inside each account's OWN Chrome
// profile, whose chrome.storage.local the dashboard (a different profile)
// cannot see. So scraped orders are routed here, on disk, where any profile
// can read them — the same cross-profile trick the config uses.
const ORDERS_PATH = path.join(CONFIG_DIR, "orders.json");

function readJsonFile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return null; // not created yet
  }
}

function writeJsonFile(p, obj) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
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

// Extension folder is always the parent of this native-host directory.
// Passing --load-extension ensures every launched profile has the bot
// loaded, even brand-new profiles that have never seen it before.
const EXTENSION_DIR = path.resolve(__dirname, "..");

function launchProfile(profileDir, url, extensionDir) {
  const chrome = findChrome();
  if (!chrome) {
    return { ok: false, error: "Chrome executable not found. Set SNKRS_CHROME_PATH." };
  }
  if (!profileDir) return { ok: false, error: "Missing profileDir." };

  const extDir = extensionDir || EXTENSION_DIR;
  const args = [
    `--profile-directory=${profileDir}`,
    `--load-extension=${extDir}`,
  ];
  if (url) args.push(url);

  try {
    const child = spawn(chrome, args, { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, pid: child.pid, chrome };
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
      return launchProfile(msg.profileDir, msg.url, msg.extensionDir);
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
