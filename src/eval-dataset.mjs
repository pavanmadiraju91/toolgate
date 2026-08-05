#!/usr/bin/env node
/**
 * Phase 3 — Turn labeled real tasks into a cost-aware-stopping dataset.
 * --------------------------------------------------------------------
 * For each labeled task we produce exactly the tuple the stopping objective
 * consumes ({scores, costs, requiredMask}, ranked by score):
 *
 *   scores      : Toolgate's real ranker fit for every candidate tool (the
 *                 upstream ranking signal), ranked desc.
 *   costs       : real per-tool schema-token footprints, mean-normalized to ~1
 *                 (heterogeneous costs — the regime where the stop matters).
 *   requiredMask: the mined/judged required set G_x mapped onto that ranking.
 *
 * Nothing here is synthetic: text -> fit is the shipping ranker, costs are the
 * shipping footprints, and G_x is the Phase-2 label. This is what replaces
 * makeTask() in train-stop.mjs.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "./catalog.mjs";
import { lexicalFit, toolFootprint } from "./ranker.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadCatalogDefault() {
  const gen = join(root, "config", "catalog.generated.json");
  return loadCatalog(existsSync(gen) ? gen : join(root, "config", "catalog.example.json"));
}

/**
 * Build one ranked task from task text + a required-tool name set, over a given
 * candidate tool set (scoped to the relevant servers — a task's "domain" — so
 * required tools aren't buried in a global cross-domain catalog).
 * @param {string} task
 * @param {Set<string>} requiredNames  set of "server.tool"
 * @param {import('./catalog.mjs').Tool[]} candidates  candidate tools for this task
 * @param {{latency:number,risk:number}} weights
 */
export function buildRankedTask(task, requiredNames, candidates, weights = { latency: 0, risk: 0 }) {
  const rows = candidates.map((t) => ({
    score: lexicalFit(task, t),
    rawCost: toolFootprint(t, weights).schemaTokens,
    required: requiredNames.has(`${t.server}.${t.tool}`),
  }));
  const meanCost = rows.reduce((s, r) => s + r.rawCost, 0) / (rows.length || 1) || 1;
  rows.sort((a, b) => b.score - a.score); // rank by score
  return {
    scores: rows.map((r) => r.score),
    costs: rows.map((r) => r.rawCost / meanCost), // mean-1 heterogeneous costs
    requiredMask: rows.map((r) => r.required),
  };
}

/**
 * Load the labeled history as ranked tasks.
 * Candidates are scoped to the servers each task actually touched (its "domain").
 * A task's required tools live in those servers, so sufficiency is attainable and
 * the stopping tradeoff is real — unlike ranking against a 105-tool global
 * catalog where required tools sink to the middle of the list.
 * @returns {{tasks:object[], stats:object}}
 */
export function loadHistoryDataset(opts = {}) {
  const catalog = opts.catalog || loadCatalogDefault();
  const byServer = new Map();
  for (const t of catalog) { if (!byServer.has(t.server)) byServer.set(t.server, []); byServer.get(t.server).push(t); }
  const labeledPath = join(root, "eval", "history", "labeled.jsonl");
  if (!existsSync(labeledPath)) throw new Error("eval/history/labeled.jsonl missing — run mine-history.mjs then label-required.mjs");
  const labeled = readFileSync(labeledPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

  const tasks = [];
  let dropped = 0, emptyReq = 0;
  for (const row of labeled) {
    const required = new Set((row.required || []).filter((n) => typeof n === "string"));
    if (!row.taskText || row.taskText.length < 8) { dropped++; continue; }
    const servers = (row.knownServers && row.knownServers.length) ? row.knownServers : [...byServer.keys()];
    const candidates = servers.flatMap((s) => byServer.get(s) || []);
    if (candidates.length < 2) { dropped++; continue; } // need a real stop decision
    const t = buildRankedTask(row.taskText, required, candidates);
    const nReq = t.requiredMask.filter(Boolean).length;
    if (nReq === 0) emptyReq++;                    // task needed no catalog tool (valid: stop at 0)
    tasks.push({ ...t, taskId: row.taskId, source: row.source, nRequired: nReq, nCandidates: candidates.length, labelMethod: row.labelMethod });
  }
  return {
    tasks,
    stats: {
      n: tasks.length, dropped, emptyReq,
      meanRequired: +(tasks.reduce((s, t) => s + t.nRequired, 0) / (tasks.length || 1)).toFixed(2),
      meanCandidates: +(tasks.reduce((s, t) => s + t.nCandidates, 0) / (tasks.length || 1)).toFixed(1),
      catalogSize: catalog.length,
    },
  };
}

// CLI: print dataset stats
if (import.meta.url === `file://${process.argv[1]}`) {
  const { tasks, stats } = loadHistoryDataset();
  console.log("History dataset:", JSON.stringify(stats, null, 2));
  const withReq = tasks.filter((t) => t.nRequired > 0).length;
  console.log(`tasks with >=1 required tool: ${withReq}/${tasks.length}`);
}
