#!/usr/bin/env node
/**
 * Toolgate broker (MCP server)
 * ----------------------------
 * The production surface. Instead of registering ~20 MCP servers (hundreds of
 * tool schemas) into every agent turn, the agent registers *only Toolgate*,
 * which exposes TWO tiny meta-tools:
 *
 *   find_tools(task)                 -> a small, explained shortlist of tools
 *   run_tool(server, tool, args)     -> proxies the call to the real MCP server
 *
 * Why a broker and not dynamic tool-list swapping? Because Claude Code, Codex,
 * and opencode all load their tool list at session start and do not reliably
 * honor MCP `tools/list_changed` mid-session. A broker keeps the agent's tool
 * list *constant* (two tools) while the shortlist decision happens inside,
 * where we fully control and log it. See docs/02-design.md.
 *
 * This file is intentionally dependency-light and defensive: if the MCP SDK
 * isn't installed it prints install instructions instead of crashing, so the
 * rest of the repo (ranker + panel) runs with zero setup.
 *
 * Run:  npm install @modelcontextprotocol/sdk  &&  node src/broker.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCatalog } from "./catalog.mjs";
import { decide } from "./ranker.mjs";
import { loadBandit } from "./prefs.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const catalog = loadCatalog(join(root, "config", "catalog.example.json"));
const config = JSON.parse(readFileSync(join(root, "config", "toolgate.config.json"), "utf8"));
const bandit = loadBandit(join(root, "config", "learned.json"));

async function main() {
  let Server, StdioServerTransport;
  try {
    ({ Server } = await import("@modelcontextprotocol/sdk/server/index.js"));
    ({ StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js"));
  } catch {
    console.error(
      "\n[toolgate] The MCP SDK is not installed, so the live broker can't start.\n" +
        "Install it with:  npm install @modelcontextprotocol/sdk\n" +
        "You can still explore the decision engine with:  npm run demo\n"
    );
    process.exit(1);
  }

  const server = new Server(
    { name: "toolgate", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  // Only two tools are ever exposed to the agent.
  const META_TOOLS = [
    {
      name: "find_tools",
      description:
        "Get a short, explained list of the tools worth loading for a task. " +
        "Returns only what earns its place in context, with a reason for each " +
        "pick. Call this before work that may need external tools.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "What you are trying to do." },
        },
        required: ["task"],
      },
    },
    {
      name: "run_tool",
      description:
        "Invoke one of the tools surfaced by find_tools. Provide the tool's " +
        "server, name, and arguments.",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string" },
          tool: { type: "string" },
          args: { type: "object" },
        },
        required: ["server", "tool"],
      },
    },
  ];

  // Late-bind SDK request schemas without a static import.
  const types = await import("@modelcontextprotocol/sdk/types.js");
  const { ListToolsRequestSchema, CallToolRequestSchema } = types;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: META_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: a } = req.params;

    if (name === "find_tools") {
      const record = decide(a.task, catalog, config, {}, bandit);
      // Return a compact, agent-friendly view + the full record for logging.
      const view = record.chosen.map((c) => ({
        server: c.tool.server,
        tool: c.tool.name,
        description: c.tool.description,
        why: `fit ${c.fit.toFixed(2)}, ${c.reason}`,
      }));
      return {
        content: [
          {
            type: "text",
            text:
              `Loaded ${record.summary.loaded}/${record.summary.total} tools ` +
              `(saved ${record.summary.pctSaved}% context)` +
              (record.summary.lowConfidence ? " \u2014 low confidence, widen if needed." : "") +
              `\n${JSON.stringify(view, null, 2)}`,
          },
        ],
      };
    }

    if (name === "run_tool") {
      // In production this dials the downstream MCP server (a connection pool
      // keyed by server name) and proxies the call. Here we return a stub so
      // the shape is clear without requiring live servers.
      return {
        content: [
          {
            type: "text",
            text:
              `[toolgate] would proxy ${a.server}.${a.tool} with args ` +
              `${JSON.stringify(a.args || {})}. Wire real downstream clients here.`,
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  await server.connect(new StdioServerTransport());
  console.error("[toolgate] broker running on stdio (find_tools, run_tool)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
