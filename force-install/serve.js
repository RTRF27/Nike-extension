// ============================================================
//  SNKRS Bot - local update server for Chrome force-install
//  Serves the signed .crx + an Omaha update manifest over
//  http://127.0.0.1:<PORT> so Chrome's ExtensionInstallForcelist
//  policy can install/update the extension in every profile.
//
//  Modern Chrome refuses file:// update URLs, so this tiny HTTP
//  server is the supported self-hosted route. No dependencies.
//
//  Run:  node serve.js        (normally started hidden at login)
// ============================================================
"use strict";

const http = require("http");
const fs   = require("fs");
const path = require("path");

const EXT_ID = "gkfbgibdipccnmamfeflgpahoehpbebf";
const PORT   = Number(process.env.SNKRS_SERVE_PORT) || 38473;
const HOST   = "127.0.0.1";

const ROOT     = path.resolve(__dirname, "..");
const CRX_PATH = path.join(ROOT, "snkrs-bot.crx");
const MANIFEST = path.join(ROOT, "manifest.json");
const PID_FILE = path.join(__dirname, ".server.pid");

function currentVersion() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")).version || "1.0"; }
  catch { return "1.0"; }
}

function updateXml() {
  const codebase = `http://${HOST}:${PORT}/snkrs-bot.crx`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="${EXT_ID}">
    <updatecheck codebase="${codebase}" version="${currentVersion()}" />
  </app>
</gupdate>`;
}

const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];

  if (url === "/update.xml") {
    res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" });
    res.end(updateXml());
    return;
  }

  if (url === "/snkrs-bot.crx") {
    fs.readFile(CRX_PATH, (err, buf) => {
      if (err) { res.writeHead(404); res.end("crx not found — run pack-crx.cjs"); return; }
      res.writeHead(200, {
        "Content-Type": "application/x-chrome-extension",
        "Content-Length": buf.length,
      });
      res.end(buf);
    });
    return;
  }

  if (url === "/" || url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`SNKRS update server OK — version ${currentVersion()} on ${HOST}:${PORT}`);
    return;
  }

  res.writeHead(404); res.end("not found");
});

// Bind to localhost only — never exposed off the machine.
server.listen(PORT, HOST, () => {
  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}
  console.log(`SNKRS update server listening on http://${HOST}:${PORT}`);
  console.log(`  update.xml -> http://${HOST}:${PORT}/update.xml`);
  console.log(`  crx        -> http://${HOST}:${PORT}/snkrs-bot.crx  (v${currentVersion()})`);
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`Port ${PORT} already in use — server probably already running.`);
    process.exit(0);
  }
  console.error("Server error:", e.message);
  process.exit(1);
});

function cleanup() { try { fs.unlinkSync(PID_FILE); } catch {} process.exit(0); }
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
