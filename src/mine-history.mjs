#!/usr/bin/env node
/**
 * Phase 1 — Mine real agent traces from local harness history.
 * ------------------------------------------------------------
 * Turns your actual agent sessions into candidate eval tasks for the cost-aware
 * stop policy, replacing the synthetic task generator in train-stop.mjs. This is
 * the "no more fabricated data" step: real task text, real tools the agent
 * reached for, mapped onto Toolgate's real catalog.
 *
 * Two sources (both local, read-only):
 *   - Claude Code : ~/.claude/projects/<slug>/<session>.jsonl   (primary harness)
 *   - opencode    : ~/.local/share/opencode/opencode.db         (secondary)
 *
 * We include Claude Code *sidechain* lines on purpose: MCP-heavy work is often
 * delegated to subagents, so that is where a lot of tool usage actually lives.
 *
 * Output: eval/history/traces.jsonl — one session-level trace per line.
 * NOTE: the acquired tool set here is a *candidate* required set (agents overcall);
 * Phase 2 (label-required.mjs) distills it to G_x via an LLM judge + heuristic.
 *
 * Usage:
 *   node src/mine-history.mjs                 # both sources, full corpus
 *   node src/mine-history.mjs --source cc     # claude-code only
 *   node src/mine-history.mjs --source oc     # opencode only
 *   node src/mine-history.mjs --limit 200     # cap CC files (quick test)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "./catalog.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const getArg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const SOURCE = getArg("--source") || "both";       // cc | oc | both
const LIMIT = Number(getArg("--limit") || 0) || 0;  // cap CC files (0 = all)

// ---- catalog + tool-name resolver -----------------------------------------
const generated = join(root, "config", "catalog.generated.json");
const catalogPath = existsSync(generated) ? generated : join(root, "config", "catalog.example.json");
const catalog = loadCatalog(catalogPath);
const KNOWN_SERVERS = [...new Set(catalog.map((t) => t.server))]
  .sort((a, b) => b.length - a.length); // longest first, so prefix matching is unambiguous
const catIndex = new Set(catalog.map((t) => `${t.server}.${t.tool}`));

const BUILTINS = new Set([
  "bash", "read", "write", "edit", "multiedit", "glob", "grep", "webfetch", "websearch",
  "todowrite", "task", "agent", "askuserquestion", "notebookedit", "list", "patch",
  "taskupdate", "taskcreate", "structuredoutput", "exitplanmode", "slashcommand",
  "bashoutput", "killshell", "taskstop", "skill",
]);

/** Normalize a raw MCP server token to a known catalog server, or null. */
function normServer(raw) {
  if (KNOWN_SERVERS.includes(raw)) return raw;
  let s = raw.replace(/^plugin_/, "");
  const toks = s.split(/[_]/);
  const cands = [s, ...toks];
  for (const c of cands) if (KNOWN_SERVERS.includes(c)) return c;
  return null;
}

/**
 * Resolve a raw tool-call name (either `mcp__server__tool` from Claude Code or
 * `server_tool` from opencode) to a catalog `{server, tool}` or a miss reason.
 */
function resolveTool(raw) {
  if (!raw) return { miss: "empty" };
  let name = raw.startsWith("mcp__") ? raw.slice(5) : raw;
  if (BUILTINS.has(name.toLowerCase())) return { builtin: true };
  if (/toolgate/i.test(name)) return { toolgate: true };

  let server = null, tool = null;
  if (name.includes("__")) {
    const parts = name.split("__");
    server = normServer(parts[0]);
    tool = parts.slice(1).join("__");
  } else {
    // opencode form: find the longest known server that prefixes the name
    const S = KNOWN_SERVERS.find((s) => name.startsWith(s + "_"));
    if (S) { server = S; tool = name.slice(S.length + 1); }
  }
  if (!server) return { miss: "server", raw };
  if (catIndex.has(`${server}.${tool}`)) return { server, tool };
  return { miss: "tool", raw, server };
}

// ---- generic trace shape ---------------------------------------------------
function emptyTrace(taskId, source) {
  return {
    taskId, source, taskText: "",
    calls: new Map(),        // "server.tool" -> { server, tool, ok, n }
    unmatched: new Map(),    // raw -> { n, server }
    knownServerMiss: 0,      // calls to a known catalog server whose tool renamed/removed
    transcript: [],          // compact turns for the Phase-2 judge
    nToolCalls: 0,
  };
}
function addCall(tr, res, ok) {
  if (res.server && res.tool && !res.miss) {
    const k = `${res.server}.${res.tool}`;
    const c = tr.calls.get(k) || { server: res.server, tool: res.tool, ok: false, n: 0 };
    c.n++; c.ok = c.ok || ok; tr.calls.set(k, c);
    tr.nToolCalls++;
  } else if (res.miss) {
    const key = res.raw || "?";
    const u = tr.unmatched.get(key) || { n: 0, server: res.server || null };
    u.n++; tr.unmatched.set(key, u);
    if (res.server) tr.knownServerMiss++; // known catalog server, tool renamed/removed since
  }
}
const TRIVIAL = new Set(["hi", "hey", "yes", "no", "ok", "okay", "yep", "yeah", "sure", "y", "n", "thanks", "ty", "continue", "go", "do it"]);
function isSubstantive(t) {
  if (!t) return false;
  const s = t.trim();
  if (s.length < 12) return false;
  if (TRIVIAL.has(s.toLowerCase())) return false;
  if (s.startsWith("<") || s.startsWith("[Request interrupted")) return false;
  return true;
}
function pushTurn(tr, role, text, cap = 600) {
  if (!text) return;
  const t = String(text).replace(/\s+/g, " ").trim();
  if (!t) return;
  tr.transcript.push(`${role}: ${t.slice(0, cap)}`);
}

function finalize(tr) {
  const calls = [...tr.calls.values()];
  const candidateReq = calls.filter((c) => c.ok).map((c) => ({ server: c.server, tool: c.tool }));
  const knownServers = [...new Set([
    ...calls.map((c) => c.server),
    ...[...tr.unmatched.values()].filter((u) => u.server).map((u) => u.server),
  ])];
  return {
    taskId: tr.taskId, source: tr.source, taskText: tr.taskText,
    calledTools: calls,
    candidateReq,                                   // M3 default: successfully-used catalog tools
    knownServers,                                   // catalog servers this task touched (rename-proof)
    unmatched: [...tr.unmatched.entries()].map(([raw, u]) => ({ raw, n: u.n, server: u.server })),
    nToolCalls: tr.nToolCalls,
    transcript: tr.transcript.join("\n").slice(0, 6000),
  };
}

// ---- Claude Code: parse a session .jsonl ----------------------------------
function textOfContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === "text").map((b) => b.text).join(" ");
  }
  return "";
}

function mineClaudeCode() {
  const base = join(homedir(), ".claude", "projects");
  if (!existsSync(base)) return [];
  const files = [];
  for (const proj of readdirSync(base)) {
    const pdir = join(base, proj);
    let entries;
    try { entries = readdirSync(pdir); } catch { continue; }
    for (const f of entries) if (f.endsWith(".jsonl")) files.push(join(pdir, f));
  }
  const chosen = LIMIT ? files.slice(0, LIMIT) : files;
  const out = [];
  for (const file of chosen) {
    const tr = emptyTrace("cc:" + file.split("/").pop().replace(/\.jsonl$/, ""), "claude-code");
    const okById = new Map();     // tool_use_id -> ok
    let raw;
    try { raw = readFileSync(file, "utf8"); } catch { continue; }
    // First pass: collect tool_result error flags (they arrive after the call).
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const c = o?.message?.content;
      if (Array.isArray(c)) for (const b of c) {
        if (b?.type === "tool_result" && b.tool_use_id) okById.set(b.tool_use_id, !b.is_error);
      }
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const msg = o?.message; if (!msg) continue;
      const sidechain = o.isSidechain === true;
      const content = msg.content;
      // task text: first substantive top-level (non-sidechain) user turn
      if (msg.role === "user" && !sidechain && !tr.taskText) {
        const t = textOfContent(content);
        if (isSubstantive(t)) { tr.taskText = t.trim(); pushTurn(tr, "USER", t, 1200); }
      }
      if (Array.isArray(content)) for (const b of content) {
        if (b?.type === "tool_use") {
          const res = resolveTool(b.name);
          const ok = okById.has(b.id) ? okById.get(b.id) : true;
          addCall(tr, res, ok);
          if (res.server && res.tool && !res.miss) pushTurn(tr, "TOOL", `${res.server}.${res.tool}`, 120);
          else if (res.server) pushTurn(tr, "TOOL~", `${res.server}.${b.name}`, 120); // renamed since
        } else if (b?.type === "text" && msg.role === "assistant") {
          pushTurn(tr, "ASSISTANT", b.text, 300);
        }
      } else if (typeof content === "string" && msg.role === "assistant") {
        pushTurn(tr, "ASSISTANT", content, 300);
      }
    }
    if (tr.taskText && (tr.calls.size > 0 || tr.knownServerMiss > 0)) out.push(finalize(tr));
  }
  return out;
}

// ---- opencode: read from the sqlite store ----------------------------------
function sql(db, query) {
  const raw = execFileSync("sqlite3", ["-json", db, query], { maxBuffer: 1 << 28 }).toString().trim();
  return raw ? JSON.parse(raw) : [];
}
function mineOpencode() {
  const db = join(homedir(), ".local", "share", "opencode", "opencode.db");
  if (!existsSync(db)) return [];
  // pull message role + text parts + tool parts, ordered
  const parts = sql(db, `
    select p.session_id as sid, m.time_created as t,
           json_extract(m.data,'$.role') as role,
           json_extract(p.data,'$.type') as ptype,
           json_extract(p.data,'$.text') as text,
           json_extract(p.data,'$.tool') as tool,
           json_extract(p.data,'$.state.status') as status
    from part p join message m on p.message_id = m.id
    order by p.session_id, m.time_created, p.id;`);
  const bySession = new Map();
  for (const r of parts) {
    if (!bySession.has(r.sid)) bySession.set(r.sid, emptyTrace("oc:" + r.sid, "opencode"));
    const tr = bySession.get(r.sid);
    if (r.ptype === "text" && r.role === "user" && !tr.taskText && isSubstantive(r.text)) {
      tr.taskText = r.text.trim(); pushTurn(tr, "USER", r.text, 1200);
    } else if (r.ptype === "text" && r.role === "assistant") {
      pushTurn(tr, "ASSISTANT", r.text, 300);
    } else if (r.ptype === "tool" && r.tool) {
      const res = resolveTool(r.tool);
      addCall(tr, res, r.status === "completed");
      if (res.server && res.tool && !res.miss) pushTurn(tr, "TOOL", `${res.server}.${res.tool}`, 120);
      else if (res.server) pushTurn(tr, "TOOL~", `${res.server}.${r.tool}`, 120);
    }
  }
  const out = [];
  for (const tr of bySession.values()) if (tr.taskText && (tr.calls.size > 0 || tr.knownServerMiss > 0)) out.push(finalize(tr));
  return out;
}

// ---- run -------------------------------------------------------------------
let traces = [];
if (SOURCE === "cc" || SOURCE === "both") traces = traces.concat(mineClaudeCode());
if (SOURCE === "oc" || SOURCE === "both") traces = traces.concat(mineOpencode());

mkdirSync(join(root, "eval", "history"), { recursive: true });
const outPath = join(root, "eval", "history", "traces.jsonl");
writeFileSync(outPath, traces.map((t) => JSON.stringify(t)).join("\n") + (traces.length ? "\n" : ""));

// summary
const bySrc = {};
let totalReq = 0, unmatchedServers = new Map();
for (const t of traces) {
  bySrc[t.source] = (bySrc[t.source] || 0) + 1;
  totalReq += t.candidateReq.length;
  for (const u of t.unmatched) if (/__|_/.test(u.raw)) unmatchedServers.set(u.raw, (unmatchedServers.get(u.raw) || 0) + u.n);
}
console.log(`Wrote ${traces.length} traces -> ${outPath}`);
console.log(`  by source: ${JSON.stringify(bySrc)}`);
console.log(`  mean candidate required tools/task: ${(totalReq / (traces.length || 1)).toFixed(2)}`);
const topUnmatched = [...unmatchedServers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
if (topUnmatched.length) console.log(`  top unmatched tool names (not in catalog): ${topUnmatched.map(([k, n]) => `${k}(${n})`).join(", ")}`);
