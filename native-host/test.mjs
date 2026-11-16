// ============================================================
// Native host tests — profile creation + profile listing.
// ============================================================
// Talks to snkrs-launcher.js over the real Native Messaging framing
// (4-byte length prefix + JSON on stdio), exactly as Chrome does.
//
// No Chrome needed: SNKRS_CHROME_PATH points at a tiny stand-in that
// either "creates" the profile folder like Chrome does, or ignores the
// request like Chrome does for a directory name it won't accept.
//
// Run:  node native-host/test.mjs      (macOS / Linux)
// ============================================================

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import fs from "node:fs";

if (process.platform === "win32") {
  console.log("Skipped: the stand-in Chrome is a shebang script (macOS/Linux only).");
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST = join(__dirname, "snkrs-launcher.js");

const work = fs.mkdtempSync(join(tmpdir(), "snkrs-host-test-"));
const userData = join(work, "User Data");
const home = join(work, "home");
fs.mkdirSync(userData);
fs.mkdirSync(home);

// A stand-in for chrome: FAKE_CHROME_MODE=ok writes a profile folder the way
// Chrome does; =ignore does nothing (Chrome's reaction to a rejected name).
const fakeChrome = join(work, "fake-chrome");
fs.writeFileSync(fakeChrome, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
if (process.env.FAKE_CHROME_MODE !== "ok") process.exit(0);
const arg = process.argv.find((a) => a.startsWith("--profile-directory="));
const dir = path.join(process.env.SNKRS_CHROME_USER_DATA_DIR, arg.split("=")[1]);
fs.mkdirSync(path.join(dir, "Network"), { recursive: true });
fs.writeFileSync(path.join(dir, "History"), "");
`, { mode: 0o755 });

function writeLocalState(infoCache) {
  fs.writeFileSync(join(userData, "Local State"), JSON.stringify({ profile: { info_cache: infoCache } }));
}

// Send one or more commands down a single port; resolve with the replies.
function send(messages, env = {}) {
  return new Promise((resolve, reject) => {
    const host = spawn(process.execPath, [HOST], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env, HOME: home, USERPROFILE: home,
        SNKRS_CHROME_PATH: fakeChrome, SNKRS_CHROME_USER_DATA_DIR: userData,
        SNKRS_CREATE_TIMEOUT_MS: "1500", FAKE_CHROME_MODE: "ok", ...env,
      },
    });
    const replies = [];
    let buf = Buffer.alloc(0);
    host.stdout.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
        const len = buf.readUInt32LE(0);
        replies.push(JSON.parse(buf.slice(4, 4 + len).toString("utf8")));
        buf = buf.slice(4 + len);
      }
      if (replies.length === messages.length) host.stdin.end();
    });
    host.on("error", reject);
    host.on("close", () => resolve(replies));
    for (const m of messages) {
      const body = Buffer.from(JSON.stringify(m), "utf8");
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length, 0);
      host.stdin.write(Buffer.concat([head, body]));
    }
  });
}
const create = async (name, env) => (await send([{ cmd: "createProfile", name, url: "about:blank" }], env))[0];

let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { passed++; results.push(`  ok    ${name}`); }
  else { failed++; results.push(`  FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}

async function main() {
  // ── No Chrome profile folder at all ──
  let r = await create("Nike 1");
  check("no Local State: refuses, points at the env override",
    !r.ok && /SNKRS_CHROME_USER_DATA_DIR/.test(r.error), JSON.stringify(r));
  check("no Local State: nothing left behind", !fs.existsSync(join(userData, "Nike 1")));

  writeLocalState({ Default: { name: "Me" }, "Profile 1": { name: "Work", active_time: 5 } });
  fs.mkdirSync(join(userData, "Default"));
  fs.writeFileSync(join(userData, "Default", "Preferences"), "{}");

  // ── Happy path ──
  r = await create("Nike 1");
  check("create: ok + verified", r.ok === true && r.verified === true && r.dir === "Nike 1", JSON.stringify(r));
  const prefs = JSON.parse(fs.readFileSync(join(userData, "Nike 1", "Preferences"), "utf8"));
  check("create: display name seeded for Chrome's profile menu", prefs.profile.name === "Nike 1");
  check("create: Chrome populated the folder", fs.existsSync(join(userData, "Nike 1", "History")));

  // ── Never reuse an existing name ──
  r = await create("Nike 1");
  check("duplicate: refused", !r.ok && r.exists === true, JSON.stringify(r));
  r = await create("nike 1");
  check("duplicate: case-insensitive (Windows/macOS file systems)", !r.ok && r.exists === true, JSON.stringify(r));
  fs.mkdirSync(join(userData, "Keep"));
  fs.writeFileSync(join(userData, "Keep", "Cookies"), "logged-in");
  r = await create("Keep");
  check("existing folder: refused", !r.ok && r.exists === true, JSON.stringify(r));
  check("existing folder: contents untouched",
    fs.readFileSync(join(userData, "Keep", "Cookies"), "utf8") === "logged-in" &&
    fs.readdirSync(join(userData, "Keep")).length === 1);

  // ── Names Chrome would silently ignore, or that belong to Chrome ──
  for (const bad of ["", "   ", "a/b", "a\\b", "..", "trail.", "na:me", "CON", "x".repeat(41),
    "Default", "Profile 7", "profile 7", "System Profile"]) {
    r = await create(bad);
    check(`bad name ${JSON.stringify(bad.slice(0, 12))}: refused before launching`, !r.ok && !r.exists && !!r.error, JSON.stringify(r));
  }
  check("bad names: no stray folders created",
    fs.readdirSync(userData).sort().join("|") === ["Default", "Keep", "Local State", "Nike 1"].sort().join("|"),
    fs.readdirSync(userData).join("|"));

  // ── Chrome didn't create it → say so, and clean up our own seed ──
  r = await create("Nike 2", { FAKE_CHROME_MODE: "ignore" });
  check("chrome ignored the launch: reported as a failure", !r.ok && /did not create/.test(r.error), JSON.stringify(r));
  check("chrome ignored the launch: seeded folder removed", !fs.existsSync(join(userData, "Nike 2")));

  // ── Listing ──
  r = (await send([{ cmd: "listProfiles" }]))[0];
  const byDir = Object.fromEntries(r.profiles.map((p) => [p.dir, p]));
  check("list: Chrome-listed profiles keep their display names",
    byDir["Profile 1"] && byDir["Profile 1"].name === "Work" && !byDir["Profile 1"].unlisted);
  check("list: on-disk profile missing from Chrome's list is still shown",
    byDir["Nike 1"] && byDir["Nike 1"].unlisted === true, JSON.stringify(r.profiles));
  check("list: listed profiles are not duplicated as unlisted",
    r.profiles.filter((p) => p.dir === "Default").length === 1);
  check("list: non-profile folders are not reported", !byDir["Keep"]);

  // ── Replies stay in request order even though createProfile is async ──
  const rs = await send([{ cmd: "createProfile", name: "Nike 3", url: "about:blank" }, { cmd: "ping" }]);
  check("ordering: slow createProfile reply comes before the later ping",
    rs.length === 2 && rs[0].dir === "Nike 3" && typeof rs[1].version === "string", JSON.stringify(rs));

  fs.rmSync(work, { recursive: true, force: true });
  console.log("\n" + results.join("\n"));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
