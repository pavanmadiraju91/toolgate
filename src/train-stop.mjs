#!/usr/bin/env node
/**
 * Train + evaluate the learned cost-aware stop policy, and save it for the broker.
 *
 * By default this trains on REAL tasks mined from your agent history
 * (Claude Code + opencode) and labeled in eval/history/labeled.jsonl — no
 * synthetic data. Costs are real schema-token footprints (heterogeneous), scores
 * are Toolgate's real ranker fit, and the required set G_x is the Phase-2 label.
 *
 * Pipeline:  node src/mine-history.mjs && node src/label-required.mjs --judge opencode && npm run train-stop
 *
 * Flags:
 *   --synthetic     train on the old synthetic generator instead (ablation/CI)
 *   --seed N        split/shuffle seed (default 42)
 *
 * Compares the learned stop against the deployable baselines (score threshold,
 * score-per-cost, fixed-k) and the oracle upper bound, under two cost-pressure
 * regimes (lambda = 0.12, 0.20), on a held-out test split.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCatalog } from "./catalog.mjs";
import { toolFootprint } from "./ranker.mjs";
import { buildExamples, train, stopDepth, payoff, features, pStop, baselines } from "./stoppolicy.mjs";
import { loadHistoryDataset } from "./eval-dataset.mjs";

const root = dirname(fileURLToPath(import.meta.url)) + "/..";
const argv = process.argv.slice(2);
const SYNTHETIC = argv.includes("--synthetic");
const SEED0 = Number((argv[argv.indexOf("--seed") + 1]) || 42) || 42;

// Use the same catalog the miner/labeler used (generated from real servers),
// falling back to the bundled sample only if it is absent.
const genCatalog = join(root, "config", "catalog.generated.json");
const catalog = loadCatalog(existsSync(genCatalog) ? genCatalog : join(root, "config", "catalog.example.json"));

// ---- seeded RNG (shared by synthetic generator + split shuffle) ------------
let seed = SEED0;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const randn = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// ---- synthetic generator (kept for --synthetic / CI ablation) --------------
const footprints = catalog.map((t) => toolFootprint(t, { latency: 0, risk: 0 }).schemaTokens);
const meanFp = footprints.reduce((a, b) => a + b, 0) / footprints.length;
function makeTask(hetero, noise = 0.4) {
  const m = catalog.length;
  const nReq = 1 + Math.floor(rnd() * 3);
  const req = new Set(); while (req.size < nReq) req.add(Math.floor(rnd() * m));
  const rows = catalog.map((t, i) => ({
    i, required: req.has(i),
    score: (req.has(i) ? 1 : 0) + noise * randn(),
    cost: hetero ? footprints[i] / meanFp : 1,
  }));
  rows.sort((a, b) => b.score - a.score);
  return { scores: rows.map((r) => r.score), costs: rows.map((r) => r.cost), requiredMask: rows.map((r) => r.required) };
}
function makeSyntheticSplits(hetero) {
  const gen = (n) => Array.from({ length: n }, () => makeTask(hetero));
  return { train: gen(600), val: gen(200), test: gen(300) };
}

// ---- real history splits (default) -----------------------------------------
function shuffle(a) { const x = a.slice(); for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; }
function loadRealSplits() {
  const { tasks, stats } = loadHistoryDataset({ catalog });
  const shuffled = shuffle(tasks);
  const nTest = Math.max(1, Math.round(shuffled.length * 0.2));
  const nVal = Math.max(1, Math.round(shuffled.length * 0.2));
  const test = shuffled.slice(0, nTest);
  const val = shuffled.slice(nTest, nTest + nVal);
  const train = shuffled.slice(nTest + nVal);
  return { train, val, test, stats };
}

// ---- eval helpers ----------------------------------------------------------
let LAMBDA = 0.12;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
function evalDepth(set, depthFn) {
  const P = [], T = [], S = [];
  for (const task of set) {
    const t = depthFn(task);
    P.push(payoff(task.costs, task.requiredMask, t, LAMBDA));
    T.push(t);
    S.push(task.requiredMask.every((r, i) => !r || i < t) ? 1 : 0);
  }
  return { payoff: mean(P), tools: mean(T), suff: mean(S) };
}
function tuneThreshold(valSet, kind) {
  const grid = kind === "fixedK" ? [...Array(catalog.length + 1).keys()]
    : Array.from({ length: 41 }, (_, i) => -1 + i * 0.05);
  let best = grid[0], bestP = -Infinity;
  for (const p of grid) {
    const fn = kind === "score" ? (t) => baselines.scoreThreshold(t.scores, t.costs, LAMBDA, p)
      : kind === "spc" ? (t) => baselines.scorePerCost(t.scores, t.costs, LAMBDA, p)
        : (t) => baselines.fixedK(t.scores, t.costs, LAMBDA, p);
    const v = evalDepth(valSet, fn).payoff;
    if (v > bestP) { bestP = v; best = p; }
  }
  return best;
}
function tuneGate(policy, valSet, lambda) {
  let best = 0.5, bestP = -Infinity;
  for (let g = 0.05; g <= 0.95; g += 0.05) {
    const v = evalDepth(valSet, (t) => stopDepth(policy, t.scores, t.costs, lambda, g)).payoff;
    if (v > bestP) { bestP = v; best = g; }
  }
  return best;
}

/**
 * Regret-identity numeric check.
 * Verifies realized prefix regret == sum of |Delta(S_t)| over states where the
 * learned policy's action disagrees with the clairvoyant optimum, along the
 * policy path. This is the invariant the regret-weighted objective is built on;
 * a nonzero result means the training target and the payoff are out of sync.
 * Returns the max abs discrepancy across tasks (should be ~0).
 */
function checkRegretIdentity(tasks, policy, lambda, gate) {
  let maxErr = 0;
  for (const task of tasks) {
    const m = task.scores.length;
    const U = []; for (let t = 0; t <= m; t++) U.push(payoff(task.costs, task.requiredMask, t, lambda));
    const F0 = Math.max(...U);
    // learned policy path
    let tau = m;
    for (let t = 0; t < m; t++) { if (pStop(policy, task.scores, task.costs, t, lambda) >= gate) { tau = t; break; } }
    // regret decomposition sum
    let sum = 0;
    for (let t = 0; t <= Math.min(tau, m - 1); t++) {
      let bestCont = -Infinity; for (let k = t + 1; k <= m; k++) bestCont = Math.max(bestCont, U[k]);
      const delta = U[t] - bestCont;          // Delta(S_t) = Q_stop - Q_continue  (paper sign)
      const Y = delta >= 0 ? 1 : -1;           // clairvoyant optimum
      const g = pStop(policy, task.scores, task.costs, t, lambda) >= gate ? 1 : -1;
      if (g !== Y) sum += Math.abs(delta);
    }
    const regret = F0 - U[tau];
    maxErr = Math.max(maxErr, Math.abs(regret - sum));
  }
  return maxErr;
}

// ---- run one lambda regime -------------------------------------------------
function run(label, splits, lambda) {
  LAMBDA = lambda;
  const policy = train(buildExamples(splits.train, lambda), { l2: 3e-3, lr: 0.4, iters: 5000 });
  const gate = tuneGate(policy, splits.val, lambda);
  policy.gate = gate; policy.lambda = lambda;
  const tauS = tuneThreshold(splits.val, "score"), tauC = tuneThreshold(splits.val, "spc"), bestK = tuneThreshold(splits.val, "fixedK");

  const rows = {
    "full access": evalDepth(splits.test, (t) => t.scores.length),
    "fixed-k (tuned)": evalDepth(splits.test, (t) => baselines.fixedK(t.scores, t.costs, lambda, bestK)),
    "score threshold": evalDepth(splits.test, (t) => baselines.scoreThreshold(t.scores, t.costs, lambda, tauS)),
    "score-per-cost": evalDepth(splits.test, (t) => baselines.scorePerCost(t.scores, t.costs, lambda, tauC)),
    "learned stop": evalDepth(splits.test, (t) => stopDepth(policy, t.scores, t.costs, lambda, gate)),
    "oracle (upper bound)": evalDepth(splits.test, (t) => baselines.oracle(t.scores, t.costs, t.requiredMask, lambda)),
  };
  const thm1 = checkRegretIdentity(splits.test, policy, lambda, gate);
  console.log(`\n=== ${label}  (lambda=${lambda}, gate=${gate.toFixed(2)}, regret-identity max|err|=${thm1.toExponential(1)}) ===`);
  console.log("method".padEnd(24) + "payoff   tools   sufficiency");
  for (const [k, v] of Object.entries(rows))
    console.log(k.padEnd(24) + v.payoff.toFixed(3).padStart(6) + "   " + v.tools.toFixed(2).padStart(5) + "   " + (v.suff * 100).toFixed(0).padStart(3) + "%");
  return policy;
}

// ---- main ------------------------------------------------------------------
let splits, mode;
if (SYNTHETIC) {
  mode = "SYNTHETIC (ablation)";
  const hetero = makeSyntheticSplits(true);
  console.log(`Training on synthetic data (--synthetic). Splits: ${hetero.train.length}/${hetero.val.length}/${hetero.test.length}`);
  run("synthetic homogeneous", makeSyntheticSplits(false), 0.12);
  run("synthetic heterogeneous", hetero, 0.12);
  const hi = run("synthetic heterogeneous, high pressure", makeSyntheticSplits(true), 0.20);
  writeFileSync(join(root, "config", "stop-policy.json"), JSON.stringify({ ...hi, source: "synthetic" }, null, 2));
} else {
  splits = loadRealSplits();
  mode = "REAL history";
  console.log(`Training on REAL mined history. Dataset: ${JSON.stringify(splits.stats)}`);
  console.log(`Splits: train=${splits.train.length} val=${splits.val.length} test=${splits.test.length} (real footprints => inherently heterogeneous costs)`);
  run("real history", splits, 0.12);
  const hi = run("real history, high pressure", splits, 0.20);
  writeFileSync(join(root, "config", "stop-policy.json"), JSON.stringify({ ...hi, source: "history", stats: splits.stats }, null, 2));
}
console.log(`\nsaved learned stop policy (${mode}) -> config/stop-policy.json`);
