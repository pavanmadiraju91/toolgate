#!/usr/bin/env node
/**
 * Generate a Toolgate catalog from your real MCP servers.
 * -------------------------------------------------------
 * Reads the opencode MCP config, connects to each server, lists its tools, and
 * writes config/catalog.generated.json in the shape the ranker expects. Servers
 * that fail to connect (auth, offline app, etc.) are skipped with a warning, so
 * one broken server doesn't sink the run.
 *
 * Run:  npm run catalog
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readServers, findConfigPath } from "./mcpConfig.mjs";
import { ClientPool } from "./mcpClients.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const WRITE_RE = /\b(write|send|create|update|delete|remove|post|edit|move|merge|push|transition|comment|upload|deploy|revoke|approve)\b/i;

function riskOf(name, desc) {
  return WRITE_RE.test(`${name} ${desc}`) ? 0.8 : 0.1;
}

async function main() {
  const cfgPath = findConfigPath();
  if (!cfgPath) { console.error("No opencode config found. Set TOOLGATE_OPENCODE_CONFIG."); process.exit(1); }
  const servers = readServers(cfgPath);
  const names = Object.keys(servers);
  console.log(`Reading ${names.length} servers from ${cfgPath}\n`);

  const pool = new ClientPool(servers, { connectTimeoutMs: 12000 });
  const tools = [];
  const report = [];

  for (const name of names) {
    try {
      const list = await pool.listTools(name);
      for (const t of list) {
        tools.push({
          name: `${name}.${t.name}`,
          server: name,
          tool: t.name,
          description: (t.description || "").split("\n")[0].slice(0, 200),
          keywords: [],
          latencyMs: servers[name].type === "remote" ? 1500 : 800,
          risk: riskOf(t.name, t.description || ""),
          schema: t.inputSchema || {},
        });
      }
      report.push(`  \u2713 ${name.padEnd(22)} ${list.length} tools`);
    } catch (e) {
      report.push(`  \u2717 ${name.padEnd(22)} skipped (${String(e.message || e).slice(0, 60)})`);
    }
  }
  await pool.closeAll();

  const outPath = join(root, "config", "catalog.generated.json");
  writeFileSync(outPath, JSON.stringify({ note: `Generated from ${cfgPath}`, generatedAt: new Date().toISOString(), tools }, null, 2));

  console.log(report.join("\n"));
  console.log(`\nWrote ${tools.length} tools from ${report.filter(r => r.includes("\u2713")).length}/${names.length} servers -> config/catalog.generated.json`);
  console.log("The broker and demo will now use this catalog automatically.");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
