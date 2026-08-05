#!/usr/bin/env node
/**
 * Phase 2 — Label the required-tool set G_x for each mined task.
 * -------------------------------------------------------------
 * A mined trace lists the tools the agent *called*, but agents overcall, so
 * "called" is only a candidate for "required". This step distills G_x with:
 *
 *   M3 (consumption, mechanical, always on): a tool is required if it was called
 *      and returned successfully. Zero-dependency, deterministic, but noisy —
 *      it inherits the agent's overcalling and undercounts renamed tools.
 *
 *   M2 (LLM judge, primary): show a capable model the task + transcript + the
 *      CURRENT catalog tools of the servers the task touched, and ask which were
 *      actually necessary. A read-only-necessity framing keeps it focused on the
 *      tools an agent must consult before acting. Rename-proof: the judge picks
 *      from today's catalog, so historical tool renames don't matter.
 *
 * We keep both, take M2 as the label when present, and record M2/M3 agreement.
 * A hand-verified eval/history/gold.jsonl (if present) is scored against both to
 * report label quality (precision/recall/F1) — the honest number that replaces
 * "trust me" for a derived (non-oracle) label.
 *
 * Usage:
 *   node src/label-required.mjs                        # M3 only (zero-dep)
 *   node src/label-required.mjs --judge opencode       # + M2 via opencode run
 *   node src/label-required.mjs --judge opencode --limit 8   # quick test
 *   node src/label-required.mjs --make-gold 30         # sample a gold template
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "./catalog.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const getArg = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const JUDGE = getArg("--judge", "none");            // none | opencode
const MODEL = getArg("--model", "anthropic/claude-opus-4-8-fast");
const LIMIT = Number(getArg("--limit", 0)) || 0;
const MAKE_GOLD = Number(getArg("--make-gold", 0)) || 0;

const catalog = loadCatalog(join(root, existsSync(join(root, "config/catalog.generated.json")) ? "config/catalog.generated.json" : "config/catalog.example.json"));
const byServer = new Map();
for (const t of catalog) { if (!byServer.has(t.server)) byServer.set(t.server, []); byServer.get(t.server).push(t); }
const catNames = new Set(catalog.map((t) => `${t.server}.${t.tool}`));

const tracesPath = join(root, "eval", "history", "traces.jsonl");
const traces = readFileSync(tracesPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

// -- gold template ----------------------------------------------------------
if (MAKE_GOLD) {
  // deterministic sample (every k-th) so the set is stable across runs
  const step = Math.max(1, Math.floor(traces.length / MAKE_GOLD));
  const pick = traces.filter((_, i) => i % step === 0).slice(0, MAKE_GOLD);
  const out = pick.map((t) => JSON.stringify({ taskId: t.taskId, taskText: t.taskText, required: [], _note: "fill required[] with server.tool names, then rename to gold.jsonl" }));
  writeFileSync(join(root, "eval", "history", "gold-template.jsonl"), out.join("\n") + "\n");
  console.log(`Wrote ${pick.length} tasks -> eval/history/gold-template.jsonl (fill required[], save as gold.jsonl)`);
  process.exit(0);
}

// -- M2 judge (opencode run) -------------------------------------------------
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
function extractJson(raw) {
  const s = stripAnsi(raw);
  // grab the last bracketed array in the output
  const m = s.match(/\[[\s\S]*\]/g);
  if (!m) return null;
  try { return JSON.parse(m[m.length - 1]); } catch { return null; }
}
function judgePrompt(t) {
  const servers = t.knownServers && t.knownServers.length ? t.knownServers : [...byServer.keys()];
  const candidates = [];
  for (const s of servers) for (const tool of byServer.get(s) || [])
    candidates.push(`${tool.server}.${tool.tool} — ${(tool.description || "").slice(0, 90)}`);
  const used = [...new Set(t.candidateReq.map((c) => `${c.server}.${c.tool}`))];
  return [
    "You are auditing an AI agent's tool use to recover the set of tools that were genuinely REQUIRED to accomplish a task.",
    "Start from the tools the agent actually used successfully (listed below) and adjust:",
    "  - KEEP a tool if the transcript shows it materially contributed to the task outcome.",
    "  - REMOVE a tool only if it was clearly redundant, an exploratory dead-end, or fully superseded by another tool.",
    "  - ADD a candidate tool only if the transcript clearly shows that capability was needed but the used tool has since been renamed (pick the current-catalog equivalent).",
    "Default to KEEP: a tool used repeatedly and productively toward the goal is required. Do not strip a task down to nothing when tools were plainly doing the work.",
    "",
    `TASK:\n${t.taskText}`,
    "",
    `TOOLS THE AGENT USED SUCCESSFULLY (your starting set):\n${used.length ? used.join("\n") : "(none matched the current catalog — infer from transcript + candidates)"}`,
    "",
    `TRANSCRIPT (compact; tool calls prefixed TOOL, renamed-but-used prefixed TOOL~):\n${t.transcript}`,
    "",
    "CANDIDATE TOOLS (current catalog for the servers this task touched; pick ONLY from these exact names):",
    candidates.join("\n"),
    "",
    'Return ONLY a JSON array of the "server.tool" names that were required. No prose before or after the array.',
  ].join("\n");
}
function runJudge(t) {
  try {
    const out = execFileSync("opencode", ["run", "--pure", "-m", MODEL, judgePrompt(t)], {
      maxBuffer: 1 << 26, timeout: 120000,
    }).toString();
    const arr = extractJson(out);
    if (!Array.isArray(arr)) return { ok: false, required: [] };
    const required = arr.filter((x) => typeof x === "string" && catNames.has(x));
    return { ok: true, required: [...new Set(required)] };
  } catch (e) {
    return { ok: false, required: [], error: String(e.message || e).slice(0, 120) };
  }
}

// -- label -------------------------------------------------------------------
const jaccard = (a, b) => {
  const A = new Set(a), B = new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter || 1);
};

const rows = LIMIT ? traces.slice(0, LIMIT) : traces;
const outPath = join(root, "eval", "history", "labeled.jsonl");
writeFileSync(outPath, ""); // fresh; write incrementally so long judge runs are crash-safe

let judged = 0, agreeSum = 0;
for (let i = 0; i < rows.length; i++) {
  const t = rows[i];
  const m3 = [...new Set(t.candidateReq.map((c) => `${c.server}.${c.tool}`))];
  let m2 = null;
  if (JUDGE === "opencode") {
    const r = runJudge(t);
    if (r.ok) { m2 = r.required; judged++; }
    process.stderr.write(`\r[judge] ${i + 1}/${rows.length} ${t.taskId} -> ${m2 ? m2.length + " req" : "FAIL"}   `);
  }
  const labelMethod = m2 ? "M2-judge" : "M3-consumption";
  const required = m2 || m3;
  const agreement = m2 ? Number(jaccard(m2, m3).toFixed(2)) : null;
  if (agreement != null) agreeSum += agreement;
  appendFileSync(outPath, JSON.stringify({
    taskId: t.taskId, source: t.source, taskText: t.taskText,
    required, requiredM3: m3, requiredM2: m2,
    labelMethod, m2m3Jaccard: agreement, knownServers: t.knownServers,
  }) + "\n");
}
if (JUDGE === "opencode") process.stderr.write("\n");

// -- gold scoring ------------------------------------------------------------
function prf(pred, gold) {
  const P = new Set(pred), G = new Set(gold);
  let tp = 0; for (const x of P) if (G.has(x)) tp++;
  const precision = P.size ? tp / P.size : (G.size ? 0 : 1);
  const recall = G.size ? tp / G.size : 1;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  return { precision, recall, f1 };
}
const goldPath = join(root, "eval", "history", "gold.jsonl");
let goldReport = "";
if (existsSync(goldPath)) {
  const gold = new Map(readFileSync(goldPath, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l)).map((g) => [g.taskId, g.required]));
  const labeled = new Map(readFileSync(outPath, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l)).map((r) => [r.taskId, r]));
  const agg = { m2: { precision: 0, recall: 0, f1: 0, n: 0 }, m3: { precision: 0, recall: 0, f1: 0, n: 0 } };
  for (const [id, g] of gold) {
    const r = labeled.get(id); if (!r) continue;
    if (r.requiredM2) { const s = prf(r.requiredM2, g); agg.m2.precision += s.precision; agg.m2.recall += s.recall; agg.m2.f1 += s.f1; agg.m2.n++; }
    const s3 = prf(r.requiredM3, g); agg.m3.precision += s3.precision; agg.m3.recall += s3.recall; agg.m3.f1 += s3.f1; agg.m3.n++;
  }
  const fmt = (a) => a.n ? `P=${(a.precision / a.n).toFixed(2)} R=${(a.recall / a.n).toFixed(2)} F1=${(a.f1 / a.n).toFixed(2)} (n=${a.n})` : "n/a";
  goldReport = `\nLabel quality vs gold:\n  M2-judge: ${fmt(agg.m2)}\n  M3-consumption: ${fmt(agg.m3)}`;
}

console.log(`Wrote ${rows.length} labels -> ${outPath}`);
console.log(`  labeler: ${JUDGE === "opencode" ? `M2 judge (${MODEL}), ${judged}/${rows.length} judged` : "M3 consumption only"}`);
if (JUDGE === "opencode" && judged) console.log(`  mean M2/M3 Jaccard: ${(agreeSum / judged).toFixed(2)}`);
if (goldReport) console.log(goldReport);
if (!existsSync(goldPath)) console.log(`  (no gold set yet — run: node src/label-required.mjs --make-gold 30, fill it, save as gold.jsonl)`);
