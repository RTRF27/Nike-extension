#!/usr/bin/env node
// ============================================================
// Reagan Runner — headless-ish Nike FLOW task runner
// ============================================================
//   node runner/src/index.js --dir ./runner --dry-run
//
// Pipeline per task:
//   real Chrome profile → product by SKU → size → Add to Bag → CheckoutWorker
//
// IMPORTANT structural difference from Void: Void's billing profiles are
// generated guest identities, so ANY checkout worker can pick up ANY checkout
// link. Here a cart lives inside a specific signed-in Chrome session, so the
// worker MUST finish the cart in the same browser context that made it. Each
// task therefore owns its context end-to-end, and the worker supplies the retry
// policy rather than the browser.
const path = require("path");
const fs = require("fs");
const { CheckoutWorker, OUTCOME } = require("./checkout-worker.js");
const D = require("./data.js");
const B = require("./browser.js");
const flow = require("./nike-flow.js");
const { notify } = require("./notify.js");

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return def;
  const nxt = process.argv[i + 1];
  return (!nxt || nxt.startsWith("--")) ? true : nxt;
}
const has = (name) => process.argv.includes("--" + name);

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (m) => console.log(`${stamp()}  ${m}`);

async function main() {
  const dir = path.resolve(String(arg("dir", path.join(__dirname, ".."))));
  const cfgPath = path.join(dir, "config.json");
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};

  const tasks = D.loadTasks(path.join(dir, "tasks.csv"));
  const workers = D.loadWorkers(path.join(dir, "workers.csv"));
  const proxies = D.loadProxies(path.join(dir, "proxies"));
  const profiles = D.loadProfiles(path.join(dir, "profiles"));

  // The user asked for it to actually buy; --dry-run is the escape hatch.
  const placeOrder = has("dry-run") ? false : (cfg.placeOrder !== false);

  log(`Reagan Runner — ${tasks.length} task(s), ${workers.length} worker(s)`);
  log(`Chrome user data: ${B.chromeUserDataDir()}`);
  log(placeOrder
    ? "⚠️  LIVE MODE — this WILL place real orders and spend real money."
    : "🧪 DRY RUN — carts only, no order will be placed.");
  if (!tasks.length) { log("No enabled tasks in tasks.csv — nothing to do."); return; }

  if (B.isChromeRunning() && !has("list-profiles")) {
    log("✗ Chrome is currently RUNNING.");
    log("  Chrome uses one process per user-data-dir, so a running Chrome takes");
    log("  over any launch and the runner can't drive your profiles.");
    log("  → Close Chrome completely (check the system tray), then run again.");
    process.exit(2);
  }

  if (has("list-profiles")) {
    log("Chrome profiles found: " + (B.listProfiles().join(", ") || "none"));
    return;
  }

  let playwright;
  try { playwright = require("playwright"); }
  catch (e) { log("✗ playwright not installed. Run:  npm i playwright"); process.exit(1); }

  const results = [];
  // Tasks that share a Chrome profile must run one at a time — a profile
  // directory can only be driven by one browser process.
  const byProfile = {};
  tasks.forEach(t => (byProfile[t.chromeProfile || "Default"] ||= []).push(t));

  await Promise.all(Object.entries(byProfile).map(async ([profileDir, list]) => {
    if (process.platform !== "win32" && B.profileLocked(profileDir)) {
      log(`✗ [${profileDir}] profile is locked by a running Chrome — close it. Skipping ${list.length} task(s).`);
      return;
    }
    for (const task of list) {
      const tag = `[${profileDir} · ${task.sku}]`;
      const wcfg = workers.find(w => w.chromeProfile === profileDir) || workers[0] || {};
      const pool = proxies[task.proxyGroup || wcfg.proxyGroup] || [];
      const proxy = pool.length ? D.parseProxy(pool[Math.floor(Math.random() * pool.length)]) : null;

      let ctx = null;
      try {
        log(`${tag} launching Chrome profile…${proxy ? " via proxy" : ""}`);
        ctx = await B.launchProfile(playwright, profileDir, { proxy, headless: !!cfg.headless });
        const page = ctx.pages()[0] || await ctx.newPage();

        const atc = await flow.addToBag(page, task, (m) => log(`${tag} ${m}`));
        if (!atc.ok) {
          log(`${tag} ✗ not carted — ${atc.reason}`);
          results.push({ task: task.sku, profile: profileDir, status: "not-carted", detail: atc.reason });
          await notify(cfg, `❌ ${task.sku} not carted on ${profileDir} — ${atc.reason}`);
          continue;
        }
        log(`${tag} 🛍️ carted ${atc.size}`);
        await notify(cfg, `🛍️ Carted ${task.sku} ${atc.size} on ${profileDir}`);

        if (!task.autoCheckout) {
          log(`${tag} auto-checkout off — leaving it in the bag.`);
          results.push({ task: task.sku, profile: profileDir, status: "carted", size: atc.size });
          continue;
        }

        // The worker owns retry/rotation policy; the page stays in this context.
        const billing = profiles[task.profileGroup || wcfg.profileGroup] || [];
        let bi = 0;
        const worker = new CheckoutWorker(
          { ...wcfg, id: wcfg.id || 1, name: wcfg.name || profileDir, proxyGroup: task.proxyGroup || wcfg.proxyGroup },
          {
            runCheckout: (job, prof) => flow.runCheckout(page, job, prof, { placeOrder }, (m) => log(`${tag} ${m}`)),
            nextProfile: () => billing.length ? billing[bi++ % billing.length] : null,
            log: (m) => log(`${tag} ${m}`),
            onResult: (job, r) => results.push({ task: task.sku, profile: profileDir, size: atc.size, ...r }),
          });
        const outcome = await worker.processJob({ id: `${profileDir}:${task.sku}`, region: task.region });
        if (outcome === OUTCOME.COMPLETED) {
          await notify(cfg, `🎉 ORDER PLACED — ${task.sku} ${atc.size} on ${profileDir}`, true);
        } else {
          await notify(cfg, `⚠️ ${task.sku} on ${profileDir} finished as "${outcome}"`);
        }
      } catch (e) {
        log(`${tag} ✗ ${B.explainLaunchError(e, profileDir)}`);
        results.push({ task: task.sku, profile: profileDir, status: "error", detail: e.message });
      } finally {
        if (ctx && !cfg.keepOpen) { try { await ctx.close(); } catch (e) {} }
      }
    }
  }));

  // Persist the run so it's auditable, same idea as Void's checkouts/ + orders/.
  const outDir = path.join(dir, "orders");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `run-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), placeOrder, results }, null, 2));
  const ok = results.filter(r => r.status === OUTCOME.COMPLETED).length;
  log(`Done — ${ok} order(s) placed, ${results.length} result(s). Written to ${file}`);
}

main().catch(e => { console.error(e); process.exit(1); });
