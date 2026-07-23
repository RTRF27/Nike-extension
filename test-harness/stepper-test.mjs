// Status stepper: the launch + checkout scripts share the same top-bar renderer.
// Verify stage progression, that the REAL picked size shows (random included),
// the checkout time appears on done, and error goes red "NEEDS MANUAL".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(join(execSync("npm root -g", { encoding: "utf8" }).trim(), "playwright"));
const ROOT = join(__dirname, "..");

// Pull the stepper block out of the real content script and run it in a page.
const src = readFileSync(join(ROOT, "snkrs-content-script.js"), "utf8");
const code = src.slice(src.indexOf("const FLOW_STEPS"), src.indexOf("// Back-compat shim"));

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log("  ✓ " + n); } else { failed++; console.log("  ✗ " + n + (d ? " — " + d : "")); } };

const b = await chromium.launch({ args: ["--no-sandbox"] });
const p = await b.newContext().then(c => c.newPage());
p.on("pageerror", e => { failed++; console.log("  ✗ page error: " + e); });
await p.setContent("<body></body>");
await p.addScriptTag({ content: "window.chrome={storage:{local:{set(){}}}};" + code });

const bar = () => p.evaluate(() => {
  const el = document.getElementById("snkrs-status-bar");
  return { text: el ? el.innerText.replace(/\n/g, " ") : null,
           bg: el ? el.style.background : null,
           segs: el ? Array.from(el.querySelectorAll("span")).map(s => s.textContent) : [] };
});

await p.evaluate(() => renderStatusBar("waiting", { size: "🎲 any available size" }));
let s = await bar();
check("waiting shows the whole flow start→end", /Waiting for drop/.test(s.text) && /Checkout/.test(s.text) && /Done/.test(s.text), s.text);
check("waiting shows the target size (random)", /any available size/.test(s.text), s.text);

await p.evaluate(() => renderStatusBar("size", { size: "US 6Y" }));
s = await bar();
check("selecting shows the REAL picked size (US 6Y)", /US 6Y/.test(s.text), s.text);
check("earlier step marked done (✓)", s.text.includes("✓"), s.text);

await p.evaluate(() => renderStatusBar("done", { time: "14:03:07", label: "Order submitted" }));
s = await bar();
check("done shows the checkout time", /14:03:07/.test(s.text), s.text);

await p.evaluate(() => renderStatusBar("error", { errorMsg: "US 6Y not offered" }));
s = await bar();
check("error goes RED", /rgb\(193, 18, 31\)|#c1121f/i.test(s.bg), s.bg);
check("error says NEEDS MANUAL", /NEEDS MANUAL/.test(s.text), s.text);

// Recover from error back to a normal stage (layout must reset to the stepper).
await p.evaluate(() => renderStatusBar("checkout", { size: "US 6Y" }));
s = await bar();
check("recovers from error to the stepper layout", s.segs.length >= 5 && !/NEEDS MANUAL/.test(s.text), s.text);

await b.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
