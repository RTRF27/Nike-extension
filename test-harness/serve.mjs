// Tiny static server for the visual runner (avoids file:// iframe quirks).
//   node test-harness/serve.mjs   → http://127.0.0.1:8977/test-harness/run.html
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const PORT = Number(process.env.PORT || 8977);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

http.createServer(async (req, res) => {
  try {
    const rel = normalize(decodeURIComponent((req.url || "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "");
    const path = join(ROOT, rel === "/" ? "test-harness/run.html" : rel);
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch (e) {
    res.writeHead(404); res.end("not found: " + req.url);
  }
}).listen(PORT, "127.0.0.1", () =>
  console.log(`Runner: http://127.0.0.1:${PORT}/test-harness/run.html`));
