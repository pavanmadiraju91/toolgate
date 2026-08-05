#!/usr/bin/env node
/**
 * Toolgate broker over HTTP (for URL-based MCP connectors like SAP Joule).
 * -----------------------------------------------------------------------
 * Same two tools as the stdio broker (find_tools, run_tool), served at a URL via
 * MCP Streamable HTTP. Point Joule's "Add Connector" URL field at:
 *
 *     http(s)://<host>:<port>/mcp
 *
 * Stateless: a fresh MCP Server + transport per request, so no session state to
 * manage across Joule's calls.
 *
 * Env:
 *   PORT            listen port (default 7800)
 *   TOOLGATE_TOKEN  if set, require `Authorization: Bearer <token>` on /mcp
 *                   (put the same value in Joule's Advanced Options auth header)
 *
 * Run:  npm install @modelcontextprotocol/sdk && node src/broker-http.mjs
 * Joule needs a public HTTPS URL, so expose it with a tunnel/reverse proxy
 * (e.g. `cloudflared tunnel --url http://localhost:7800`) or deploy it.
 */
import { createServer } from "node:http";
import { loadDeps, importSdk, buildServer } from "./broker.mjs";

const PORT = Number(process.env.PORT || 7800);
const TOKEN = process.env.TOOLGATE_TOKEN || null;
const MCP_PATH = "/mcp";

const deps = loadDeps();
const sdk = await importSdk();
const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : undefined); } catch { resolve(undefined); } });
    req.on("error", () => resolve(undefined));
  });
}
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // Health check / hint page.
  if (url.pathname === "/" || url.pathname === "/health") {
    return json(res, 200, { name: "toolgate", transport: "streamable-http", endpoint: MCP_PATH, tools: ["find_tools", "run_tool"], catalog: deps.catalog.length });
  }
  if (url.pathname !== MCP_PATH) return json(res, 404, { error: "not found", hint: `MCP endpoint is ${MCP_PATH}` });

  // Optional bearer-token auth (Joule Advanced Options can send this header).
  if (TOKEN) {
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${TOKEN}`) return json(res, 401, { error: "unauthorized" });
  }

  // Stateless: new server + transport per request.
  const body = req.method === "POST" ? await readBody(req) : undefined;
  const server = buildServer(deps, sdk);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close?.(); server.close?.(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e?.message || e) });
  }
});

httpServer.listen(PORT, () => {
  console.error(`[toolgate] HTTP broker on http://127.0.0.1:${PORT}${MCP_PATH} · ${deps.catalog.length} tools${TOKEN ? " · bearer-token required" : ""} · log: ${deps.logPath}`);
  console.error(`[toolgate] For Joule: expose this with a public HTTPS tunnel and use <url>${MCP_PATH} as the connector URL.`);
});
