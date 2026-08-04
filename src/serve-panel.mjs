#!/usr/bin/env node
/**
 * Tiny zero-dependency static server for the legibility panel.
 * Serves the repo root so the panel can import the shared /src learner modules.
 * Open http://127.0.0.1:7799/ (redirects to the panel).
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const PORT = process.env.PORT || 7799;

const MIME = { ".html": "text/html", ".json": "application/json", ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css" };

const server = createServer(async (req, res) => {
  let path = decodeURIComponent((req.url || "/").split("?")[0]);
  if (path === "/") path = "/panel/index.html";
  const full = normalize(join(rootDir, path));
  if (!full.startsWith(rootDir)) { res.writeHead(403); res.end("no"); return; }
  try {
    const buf = await readFile(full);
    res.writeHead(200, { "content-type": MIME[extname(full)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found. Run `npm run demo` first to generate panel/decisions.json.");
  }
});

server.listen(PORT, () => console.log(`Toolgate panel -> http://127.0.0.1:${PORT}/`));
