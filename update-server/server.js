#!/usr/bin/env node
// ============================================================
// server.js — the local extension update server.
// ============================================================
// Serves, on http://127.0.0.1:38473 (loopback only):
//
//   /update.xml     Omaha manifest Chrome's forcelist polls
//   /snkrs-bot.crx  the signed package
//   /version.json   { id, version, ts } — the dashboard's banner reads this
//   /healthz        "ok" — used by the installer's verify step
//
// Everything is re-read from dist/ ON EVERY REQUEST, so publishing an
// update is just:  bump manifest version → node pack.js.  No restart.
//
// If the port is already taken we exit 0 quietly — the scheduled task can
// fire "start server" as often as it likes without stacking processes.
// ============================================================

"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.SNKRS_UPDATE_PORT || 38473);
const DIST = path.join(__dirname, "dist");
const CRX = path.join(DIST, "snkrs-bot.crx");
const INFO = path.join(DIST, "info.json");

function readInfo() {
  try { return JSON.parse(fs.readFileSync(INFO, "utf8")); }
  catch (e) { return null; }
}

function updateXml(info) {
  return `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${info.id}'>
    <updatecheck codebase='http://127.0.0.1:${PORT}/snkrs-bot.crx' version='${info.version}' />
  </app>
</gupdate>
`;
}

const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  const info = readInfo();

  if (url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (url === "/version.json") {
    res.writeHead(info ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(info
      ? { ok: true, id: info.id, version: info.version, ts: info.ts, crxBytes: info.crxBytes }
      : { ok: false, error: "not packed yet — run: node update-server/pack.js" }));
    return;
  }

  if (url === "/update.xml") {
    if (!info || !fs.existsSync(CRX)) {
      // 404 (not a bogus manifest) — Chrome treats it as "no update available"
      // and keeps whatever is already installed.
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not packed yet");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/xml", "Cache-Control": "no-store" });
    res.end(updateXml(info));
    return;
  }

  if (url === "/snkrs-bot.crx") {
    let body;
    try { body = fs.readFileSync(CRX); }
    catch (e) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("crx missing — run pack.js");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/x-chrome-extension",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
    });
    res.end(body);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("SNKRS update server — endpoints: /update.xml /snkrs-bot.crx /version.json /healthz");
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    // Another instance is already serving — that's success, not failure.
    console.log(`update server already running on :${PORT} — exiting.`);
    process.exit(0);
  }
  console.error("update server error:", e.message);
  process.exit(1);
});

// Loopback ONLY. The .crx must never be reachable from the network.
server.listen(PORT, "127.0.0.1", () => {
  const info = readInfo();
  console.log(`SNKRS update server on http://127.0.0.1:${PORT}` +
    (info ? ` — serving ${info.id} v${info.version}` : " — dist/ empty, run pack.js"));
});
