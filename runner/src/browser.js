// Browser layer — the whole reason this runner is worth having.
//
// It drives your REAL, already-signed-in Chrome profiles via
// launchPersistentContext, instead of a clean automated Chromium. That matters
// more than anything else in here: Nike fronts its store with Kasada, and a
// fresh browser with no history, no cookies and an automation fingerprint gets
// flagged quickly. Your existing profiles already hold real Kasada cookies and
// a real browsing history — that trust IS the anti-detection, and it's exactly
// what paid bots spend money re-creating.
//
// Consequences of that choice, stated plainly:
//   • Chrome must be CLOSED for a profile before we can drive it — Chrome locks
//     its user-data dir, and a second process cannot attach to it.
//   • Sessions are shared with your real browsing. A logged-out profile here is
//     logged out when you open Chrome normally.
const fs = require("fs");
const os = require("os");
const path = require("path");

function chromeUserDataDir() {
  if (process.env.SNKRS_CHROME_USER_DATA_DIR) return process.env.SNKRS_CHROME_USER_DATA_DIR;
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "Google", "Chrome", "User Data");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  }
  return path.join(os.homedir(), ".config", "google-chrome");
}

function chromeExecutable() {
  if (process.env.SNKRS_CHROME_PATH) return process.env.SNKRS_CHROME_PATH;
  const c = process.platform === "win32"
    ? [path.join(process.env["PROGRAMFILES"] || "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
       path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google/Chrome/Application/chrome.exe"),
       path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe")]
    : process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
  return c.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } }) || null;
}

function listProfiles() {
  const root = chromeUserDataDir();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(d => {
    try {
      return fs.statSync(path.join(root, d)).isDirectory() &&
             (d === "Default" || /^Profile \d+$/.test(d)) &&
             fs.existsSync(path.join(root, d, "Preferences"));
    } catch (e) { return false; }
  });
}

// Playwright can only take the user-data-dir ROOT plus --profile-directory, so
// we pass the root and name the profile via an arg. Copying a profile instead
// would lose the very cookies we're here for.
async function launchProfile(playwright, profileDir, { proxy, headless = false, args = [] } = {}) {
  const root = chromeUserDataDir();
  const exe = chromeExecutable();
  if (!exe) throw new Error("Chrome not found — set SNKRS_CHROME_PATH.");
  if (!fs.existsSync(path.join(root, profileDir))) {
    throw new Error(`Chrome profile "${profileDir}" not found in ${root}`);
  }
  return playwright.chromium.launchPersistentContext(root, {
    executablePath: exe,
    headless,
    proxy: proxy || undefined,
    viewport: null,
    args: [
      `--profile-directory=${profileDir}`,
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--no-first-run", "--no-default-browser-check",
      ...args,
    ],
  });
}

// Chrome runs ONE browser process per user-data-dir. If any Chrome window is
// open — on any profile — launching another with --profile-directory just hands
// the URL to the running instance and Playwright never gets control ("Opening in
// existing browser session"). So the real precondition is "Chrome is fully
// closed", not "this profile is unlocked".
//
// SingletonLock only exists on Linux/macOS, which is why a naive lock check
// passes on Windows and then fails confusingly at launch.
function isChromeRunning() {
  const { execSync } = require("child_process");
  try {
    if (process.platform === "win32") {
      const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: "utf8", windowsHide: true, timeout: 8000 });
      return /chrome\.exe/i.test(out);
    }
    const out = execSync("pgrep -x 'Google Chrome' || pgrep -x chrome || true", { encoding: "utf8", timeout: 8000 });
    return out.trim().length > 0;
  } catch (e) { return false; }   // can't tell → let the launch decide
}

// Kept for POSIX, where the per-profile lock is meaningful.
function profileLocked(profileDir) {
  const p = path.join(chromeUserDataDir(), profileDir, "SingletonLock");
  try { return fs.existsSync(p); } catch (e) { return false; }
}

// Playwright's message for this is a wall of command-line noise; translate it.
function explainLaunchError(e, profileDir) {
  const m = String((e && e.message) || e);
  if (/existing browser session|already in use/i.test(m)) {
    return `Chrome is already running, so "${profileDir}" can't be driven. ` +
           `Chrome uses one process per user-data-dir — CLOSE Chrome completely ` +
           `(check the tray) and run again.`;
  }
  if (/not found in/i.test(m)) return m;
  return m.split("\n")[0].slice(0, 200);
}

module.exports = { chromeUserDataDir, chromeExecutable, listProfiles, launchProfile,
                   profileLocked, isChromeRunning, explainLaunchError };
