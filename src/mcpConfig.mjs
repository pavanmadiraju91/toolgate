/**
 * Read the real MCP server definitions from an opencode config file, so
 * Toolgate brokers exactly the tools opencode is configured with (no separate
 * format to maintain). Supports local (stdio) and remote (http/sse) servers.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PATHS = [
  process.env.TOOLGATE_OPENCODE_CONFIG,
  join(process.cwd(), "opencode.json"),
  join(homedir(), ".config", "opencode", "opencode.json"),
].filter(Boolean);

export function findConfigPath() {
  return DEFAULT_PATHS.find((p) => existsSync(p)) || null;
}

/** Servers Toolgate should never broker (broken/unwanted), from config/ignore.json + TOOLGATE_IGNORE. */
function ignoreSet() {
  const s = new Set();
  for (const n of (process.env.TOOLGATE_IGNORE || "").split(",")) if (n.trim()) s.add(n.trim());
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "ignore.json");
    if (existsSync(p)) for (const n of JSON.parse(readFileSync(p, "utf8"))) s.add(n);
  } catch { /* ignore */ }
  return s;
}

/**
 * @returns {Record<string, {name:string,type:string,command?:string,args?:string[],env?:object,url?:string,headers?:object}>}
 */
export function readServers(path = findConfigPath()) {
  if (!path || !existsSync(path)) return {};
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  const ignore = ignoreSet();
  const out = {};
  for (const [name, s] of Object.entries(cfg.mcp || {})) {
    // Note: we intentionally do NOT skip servers marked `enabled: false`.
    // Daily-drive mode disables them for opencode (so only Toolgate connects),
    // but Toolgate still needs their definitions to broker them via run_tool.
    if (/toolgate/i.test(name)) continue; // never broker ourselves
    if (ignore.has(name)) continue;       // explicitly ignored (broken/unwanted)
    if (s.type === "local" && Array.isArray(s.command)) {
      if (s.command.join(" ").includes("toolgate")) continue;
      out[name] = { name, type: "local", command: s.command[0], args: s.command.slice(1), env: s.environment || {} };
    } else if (s.type === "remote" && s.url) {
      out[name] = { name, type: "remote", url: s.url, headers: s.headers || {} };
    }
  }
  return out;
}
