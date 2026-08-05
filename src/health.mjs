#!/usr/bin/env node
/**
 * Health check — is every connected MCP server actually reachable?
 * ----------------------------------------------------------------
 * For each server in your opencode config, Toolgate connects with the real MCP
 * client and calls tools/list. That exercises the full path run_tool uses
 * (transport + initialize + list) WITHOUT invoking any downstream tool, so it's
 * side-effect free — no messages sent, nothing written.
 *
 * Run:  npm run health   (npm install @modelcontextprotocol/sdk first)
 */
import { readServers } from "./mcpConfig.mjs";
import { ClientPool } from "./mcpClients.mjs";

const PER_SERVER_TIMEOUT = Number(process.env.TOOLGATE_HEALTH_TIMEOUT || 20000);

const servers = readServers();
const names = Object.keys(servers);
if (!names.length) { console.error("No MCP servers found in opencode config."); process.exit(1); }

const pool = new ClientPool(servers, { connectTimeoutMs: PER_SERVER_TIMEOUT });

const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms))]);

async function check(name) {
  const server = servers[name];
  const where = server.type === "local" ? `${server.command} ${(server.args || []).join(" ")}`.trim() : server.url;
  const started = Date.now();
  try {
    const tools = await withTimeout(pool.listTools(name), PER_SERVER_TIMEOUT, name);
    return { name, ok: true, tools: tools.length, ms: Date.now() - started, type: server.type, where };
  } catch (e) {
    return { name, ok: false, error: String(e.message || e).slice(0, 100), ms: Date.now() - started, type: server.type, where };
  }
}

console.error(`Pinging ${names.length} MCP servers (tools/list, read-only)...\n`);
const results = await Promise.all(names.map(check));
results.sort((a, b) => Number(b.ok) - Number(a.ok) || a.name.localeCompare(b.name));

const pad = (s, n) => String(s).padEnd(n);
let up = 0;
for (const r of results) {
  const status = r.ok ? "  UP " : "DOWN ";
  const detail = r.ok ? `${r.tools} tools` : r.error;
  console.log(`${status} ${pad(r.name, 20)} ${pad(r.type, 7)} ${pad(r.ms + "ms", 8)} ${detail}`);
  if (r.ok) up++;
}
console.log(`\n${up}/${results.length} servers reachable.`);

await pool.closeAll();
process.exit(up === results.length ? 0 : 1);
