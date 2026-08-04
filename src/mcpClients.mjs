/**
 * Downstream MCP client pool.
 * ---------------------------
 * Lazily connects to a real MCP server (using the official SDK client +
 * transport) the first time a tool on it is needed, caches the connection, and
 * forwards calls. This is how run_tool actually executes a tool: no bespoke
 * protocol code, just the SDK.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

function transportFor(server) {
  if (server.type === "local") {
    return new StdioClientTransport({
      command: server.command,
      args: server.args || [],
      env: { ...process.env, ...(server.env || {}) },
    });
  }
  const url = new URL(server.url);
  const requestInit = server.headers && Object.keys(server.headers).length ? { headers: server.headers } : undefined;
  // opencode's own convention: /sse endpoints use the SSE transport, else Streamable HTTP.
  if (url.pathname.endsWith("/sse")) return new SSEClientTransport(url, { requestInit });
  return new StreamableHTTPClientTransport(url, { requestInit });
}

export class ClientPool {
  /** @param {Record<string, object>} servers */
  constructor(servers, { connectTimeoutMs = 15000 } = {}) {
    this.servers = servers;
    this.connectTimeoutMs = connectTimeoutMs;
    /** @type {Map<string, Promise<Client>>} */
    this.clients = new Map();
  }

  async client(serverName) {
    const server = this.servers[serverName];
    if (!server) throw new Error(`Unknown server: ${serverName}`);
    if (!this.clients.has(serverName)) {
      this.clients.set(serverName, this._connect(server));
    }
    return this.clients.get(serverName);
  }

  async _connect(server) {
    const c = new Client({ name: "toolgate", version: "0.1.0" }, { capabilities: {} });
    const connect = c.connect(transportFor(server));
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error(`connect timeout: ${server.name}`)), this.connectTimeoutMs));
    await Promise.race([connect, timeout]);
    return c;
  }

  async listTools(serverName) {
    const c = await this.client(serverName);
    return (await c.listTools()).tools;
  }

  async callTool(serverName, toolName, args) {
    const c = await this.client(serverName);
    return c.callTool({ name: toolName, arguments: args || {} });
  }

  async closeAll() {
    for (const p of this.clients.values()) {
      try { (await p).close(); } catch { /* ignore */ }
    }
  }
}
