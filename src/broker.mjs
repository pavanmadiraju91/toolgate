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
 * Run:  npm install @modelcontextprotocol/sdk && node src/broker.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCatalog } from "./catalog.mjs";
import { decide } from "./ranker.mjs";
import { loadBandit } from "./prefs.mjs";
import { readServers } from "./mcpConfig.mjs";
import { ClientPool } from "./mcpClients.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const generated = join(root, "config", "catalog.generated.json");
const catalogPath = existsSync(generated) ? generated : join(root, "config", "catalog.example.json");
const catalog = loadCatalog(catalogPath);
const config = JSON.parse(readFileSync(join(root, "config", "toolgate.config.json"), "utf8"));
const bandit = loadBandit(join(root, "config", "learned.json"));
const pool = new ClientPool(readServers());

async function main() {
  let Server, StdioServerTransport, types;
  try {
    ({ Server } = await import("@modelcontextprotocol/sdk/server/index.js"));
    ({ StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js"));
    types = await import("@modelcontextprotocol/sdk/types.js");
  } catch {
    console.error("\n[toolgate] MCP SDK not installed. Run: npm install @modelcontextprotocol/sdk\n");
    process.exit(1);
  }
  const { ListToolsRequestSchema, CallToolRequestSchema } = types;

  const server = new Server({ name: "toolgate", version: "0.1.0" }, { capabilities: { tools: {} } });

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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: META_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: a } = req.params;

    if (name === "find_tools") {
      const record = decide(a.task, catalog, config, {}, bandit);
      const view = record.chosen.map((c) => ({
        server: c.tool.server,
        tool: c.tool.tool || c.tool.name,
        description: c.tool.description,
        why: `fit ${c.fit.toFixed(2)}, ${c.reason}`,
        arguments: c.tool.schema || {},
      }));
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
      try {
        const res = await pool.callTool(a.server, a.tool, a.args || {});
        return res; // pass the downstream tool's result straight through
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `[toolgate] ${a.server}.${a.tool} failed: ${String(e.message || e)}` }] };
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  await server.connect(new StdioServerTransport());
  console.error(`[toolgate] broker on stdio · catalog: ${catalogPath.split("/").pop()} · ${catalog.length} tools`);
}

main().catch((e) => { console.error(e); process.exit(1); });
