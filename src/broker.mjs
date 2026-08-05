#!/usr/bin/env node
/**
 * Toolgate broker (MCP server)
 * ----------------------------
 * The agent registers only Toolgate, which exposes two tools:
 *
 *   find_tools(task)              -> a short, explained shortlist of tools
 *   run_tool(server, tool, args)  -> executes a downstream tool for real
 *
 * find_tools runs the ranker over a catalog. run_tool forwards to the actual
 * MCP server via the SDK client pool. The agent's visible tool list stays two
 * tools wide; the real decision (and the real call) happen inside here, where
 * they can be logged and overruled.
 *
 * Catalog: uses config/catalog.generated.json if present (run `npm run catalog`
 * to build it from your real servers), otherwise the bundled sample.
 *
 * Transports:
 *   node src/broker.mjs        stdio  (opencode, Claude Code, Codex, Gemini CLI)
 *   node src/broker-http.mjs   HTTP   (SAP Joule and other URL-based connectors)
 * Both share buildServer()/loadDeps() below.
 *
 * Run:  npm install @modelcontextprotocol/sdk && node src/broker.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCatalog } from "./catalog.mjs";
import { decide } from "./ranker.mjs";
import { semanticFitFor, saveCache } from "./embeddings.mjs";
import { loadBandit } from "./prefs.mjs";
import { readServers } from "./mcpConfig.mjs";
import { ClientPool } from "./mcpClients.mjs";
import { createLogger } from "./logger.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

/** Load catalog, policy, bandit, and the downstream client pool once. */
export function loadDeps() {
  const generated = join(root, "config", "catalog.generated.json");
  const catalogPath = existsSync(generated) ? generated : join(root, "config", "catalog.example.json");
  const catalog = loadCatalog(catalogPath);
  const config = JSON.parse(readFileSync(join(root, "config", "toolgate.config.json"), "utf8"));
  const bandit = loadBandit(join(root, "config", "learned.json"));
  const stopPolicyPath = join(root, "config", "stop-policy.json");
  const stopPolicy = existsSync(stopPolicyPath) ? JSON.parse(readFileSync(stopPolicyPath, "utf8")) : null;
  const pool = new ClientPool(readServers());
  const logPath = process.env.TOOLGATE_LOG || join(root, "eval", "history", "broker-log.jsonl");
  const logger = createLogger(logPath);
  return { catalog, config, bandit, stopPolicy, pool, catalogPath, logPath, logger };
}

export async function importSdk() {
  try {
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const types = await import("@modelcontextprotocol/sdk/types.js");
    return { Server, types };
  } catch {
    console.error("\n[toolgate] MCP SDK not installed. Run: npm install @modelcontextprotocol/sdk\n");
    process.exit(1);
  }
}

const META_TOOLS = [
  {
    name: "find_tools",
    description:
      "Get a short, explained list of the tools worth loading for a task. " +
      "Returns only what earns its place in context, with a reason for each " +
      "pick. Call this before work that may need external tools.",
    inputSchema: { type: "object", properties: { task: { type: "string", description: "What you are trying to do." } }, required: ["task"] },
  },
  {
    name: "run_tool",
    description:
      "Invoke one of the tools surfaced by find_tools. Pass its server, tool " +
      "name, and arguments; Toolgate forwards the call to that server.",
    inputSchema: {
      type: "object",
      properties: { server: { type: "string" }, tool: { type: "string" }, args: { type: "object" } },
      required: ["server", "tool"],
    },
  },
];

/**
 * Build a fully-wired Toolgate MCP Server (the two meta-tools + handlers).
 * Shared by every transport. A fresh Server can be built per HTTP request.
 * @param {ReturnType<typeof loadDeps>} deps
 * @param {{Server:any, types:any}} sdk
 */
export function buildServer(deps, sdk) {
  const { catalog, config, bandit, stopPolicy, pool } = deps;
  const { Server, types } = sdk;
  const { ListToolsRequestSchema, CallToolRequestSchema } = types;

  const server = new Server({ name: "toolgate", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: META_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: a } = req.params;

    if (name === "find_tools") {
      // Semantic fit (embeddings) when available; falls back to lexical inside decide().
      const fit = await semanticFitFor(catalog, a.task);
      saveCache();
      // Default: return the relevant shortlist (semantic top-k above the relevance
      // floor) — the useful thing to hand an LLM. Set TOOLGATE_STOP=1 to instead
      // apply the learned cost-aware stop (minimal single-prefix acquisition).
      const useStop = process.env.TOOLGATE_STOP === "1";
      const record = decide(a.task, catalog, fit ? { ...config, fit } : config, {}, bandit, useStop ? stopPolicy : null);
      const view = record.chosen.map((c) => ({
        server: c.tool.server,
        tool: c.tool.tool || c.tool.name,
        description: c.tool.description,
        why: `fit ${c.fit.toFixed(2)}, ${c.reason}`,
        arguments: c.tool.schema || {},
      }));
      deps.logger.info({
        loaded: record.summary.loaded, total: record.summary.total,
        pctSaved: record.summary.pctSaved, lowConfidence: record.summary.lowConfidence,
        task: a.task, chosen: view.map((v) => `${v.server}.${v.tool}`),
      }, "find_tools");
      return {
        content: [{
          type: "text",
          text:
            `Loaded ${record.summary.loaded}/${record.summary.total} tools ` +
            `(saved ${record.summary.pctSaved}% context)` +
            (record.summary.lowConfidence ? " \u2014 low confidence, widen if needed." : "") +
            `\nTo use one, call run_tool with its server, tool, and args matching "arguments" below.\n${JSON.stringify(view, null, 2)}`,
        }],
      };
    }

    if (name === "run_tool") {
      const started = Date.now();
      try {
        const res = await pool.callTool(a.server, a.tool, a.args || {});
        deps.logger.info({ server: a.server, tool: a.tool, ok: !res?.isError, ms: Date.now() - started }, "run_tool");
        return res; // pass the downstream tool's result straight through
      } catch (e) {
        deps.logger.error({ server: a.server, tool: a.tool, ok: false, ms: Date.now() - started, error: String(e.message || e).slice(0, 200) }, "run_tool");
        return { isError: true, content: [{ type: "text", text: `[toolgate] ${a.server}.${a.tool} failed: ${String(e.message || e)}` }] };
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}

async function main() {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const deps = loadDeps();
  const sdk = await importSdk();
  const server = buildServer(deps, sdk);
  await server.connect(new StdioServerTransport());
  console.error(`[toolgate] broker on stdio · catalog: ${deps.catalogPath.split("/").pop()} · ${deps.catalog.length} tools · log: ${deps.logPath}`);
}

// Only run stdio when invoked directly (not when imported by broker-http.mjs).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
