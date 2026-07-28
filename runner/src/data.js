// Data layer: CSV, named proxy groups, billing profiles, workers, tasks.
// Mirrors Void's on-disk shape (tasks.csv / workers.csv / proxies/*.txt /
// profiles/*.csv) so files are portable between the two.
const fs = require("fs");
const path = require("path");

// ── CSV (RFC4180: quoted fields, embedded commas, "" escapes) ──
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  const s = String(text || "").replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ""));
}
function csvEscape(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// → array of objects keyed by normalised header (lower_snake).
function readCsvObjects(file) {
  if (!fs.existsSync(file)) return [];
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  if (rows.length < 2) return [];
  const head = rows[0].map(h => String(h).trim().toLowerCase().replace(/\s+/g, "_"));
  return rows.slice(1).map(r => {
    const o = {};
    head.forEach((h, i) => { o[h] = String(r[i] == null ? "" : r[i]).trim(); });
    return o;
  });
}
function writeCsvObjects(file, cols, objs) {
  const lines = [cols.join(",")];
  objs.forEach(o => lines.push(cols.map(c => csvEscape(o[c])).join(",")));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n"), "utf8");
}

const truthy = (v) => /^(true|yes|1|on)$/i.test(String(v || "").trim());
const num = (v, d) => { const n = parseFloat(v); return isNaN(n) ? d : n; };

// ── Proxies ───────────────────────────────────────────────────
// Void keeps one file per group (proxies/Vital.txt). We accept that AND the
// extension's single-file [Group] header format, so either layout works.
function loadProxies(dir) {
  const groups = {};
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.txt$/i.test(f)) continue;
      const name = f.replace(/\.txt$/i, "");
      groups[name] = fs.readFileSync(path.join(dir, f), "utf8")
        .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
    }
  } else if (fs.existsSync(dir)) {
    let cur = "Default";
    fs.readFileSync(dir, "utf8").split(/\r?\n/).forEach(line => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return;
      const m = t.match(/^\[(.+)\]$/);
      if (m) { cur = m[1].trim(); groups[cur] = groups[cur] || []; return; }
      (groups[cur] = groups[cur] || []).push(t);
    });
  }
  return groups;
}
// "host:port:user:pass" → Playwright proxy object.
function parseProxy(line) {
  if (!line) return null;
  const p = String(line).trim().split(":");
  if (p.length < 2) return null;
  const server = `http://${p[0]}:${p[1]}`;
  return p.length >= 4 ? { server, username: p[2], password: p.slice(3).join(":") } : { server };
}

// ── Billing profiles (profiles/<Group>.csv) ───────────────────
function loadProfiles(dir) {
  const groups = {};
  if (!fs.existsSync(dir)) return groups;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.csv$/i.test(f)) continue;
    groups[f.replace(/\.csv$/i, "")] = readCsvObjects(path.join(dir, f));
  }
  return groups;
}

// ── Tasks (tasks.csv) ─────────────────────────────────────────
// Columns follow Void's nike.csv where they map; `chrome_profile` is ours —
// it's the real logged-in Chrome profile dir the task drives.
function loadTasks(file) {
  return readCsvObjects(file).map((r, i) => ({
    id: r.id || String(i + 1),
    sku: (r.sku || "").toUpperCase(),
    region: (r.region || "sg").toLowerCase(),
    mode: (r.mode || "flow").toLowerCase(),          // flow | snkrs
    sizes: String(r.sizes || "").split(/[;|]/).map(s => s.trim()).filter(Boolean),
    chromeProfile: r.chrome_profile || r.profile || "",
    profileGroup: r.profile_group || r.billing_profile || "",
    proxyGroup: r.proxies || r.proxy || "",
    delayMs: num(r.delay, 3000),
    quantity: Math.max(1, num(r.cart_quantities || r.quantity, 1)),
    maxTasks: Math.max(1, num(r.max_tasks, 1)),
    ignoreTimer: truthy(r.ignore_timer),
    autoCheckout: r.auto_checkout === "" ? true : truthy(r.auto_checkout),
    enabled: r.enabled === "" ? true : truthy(r.enabled || "true"),
  })).filter(t => t.sku && t.enabled);
}

// ── Workers (workers.csv) ─────────────────────────────────────
function loadWorkers(file) {
  return readCsvObjects(file).map((r, i) => ({
    id: r.id || String(i + 1),
    name: r.name || `worker-${i + 1}`,
    proxyGroup: r.proxy_list || r.proxies || "",
    chromeProfile: r.chrome_profile || "",
    maxRetries: num(r.max_retries, 5),
    retryDelayMs: num(r.retry_delay_seconds, 5) * 1000,
    profileRotateRetries: num(r.profile_rotate_retries, 3),
    timeLimitMs: num(r.time_limit_minutes, 25) * 60000,
    stopOnCartExpiry: r.stop_on_cart_expiry === "" ? true : truthy(r.stop_on_cart_expiry),
    enabled: r.enabled === "" ? true : truthy(r.enabled),
    profileGroup: r.profile_group || "",
  })).filter(w => w.enabled);
}

const WORKER_COLS = ["id", "name", "proxy_list", "max_retries", "retry_delay_seconds",
  "profile_rotate_retries", "time_limit_minutes", "stop_on_cart_expiry", "enabled",
  "completed", "declined", "started_at", "stopped_at"];

module.exports = { parseCsv, csvEscape, readCsvObjects, writeCsvObjects,
                   loadProxies, parseProxy, loadProfiles, loadTasks, loadWorkers,
                   WORKER_COLS, truthy, num };
