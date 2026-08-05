/**
 * Toolgate — the shortlist engine
 * -------------------------------
 * Decides *which* tools an agent should bring to a task, and produces a legible
 * record of *why*.
 *
 * Origin: running ~20 tool servers day to day, every agent turn drags hundreds
 * of tool definitions into context whether the task needs them or not. That
 * bloats the prompt, slows things down, widens the blast radius, and — worst for
 * a human supervising the agent — happens invisibly. Toolgate turns "load
 * everything, always" into a small, explained shortlist you can see and change.
 *
 * Each tool earns its place through one tradeoff:
 *   - fit       : how well it matches the task (0..1)
 *   - footprint : the room it takes in context (schema tokens, nudged up for
 *                 slow or sensitive tools)
 *   - worth     : fit minus a fraction of its (normalized) footprint, plus what
 *                 the learner has picked up from your past board/hold choices
 * Walk tools best-fit first, keep boarding while each is still worth the room,
 * and stop at the gate. Record where the line landed and how sure we are.
 */
import { tokenize, termFreq, cosine } from "./text.mjs";
import { stopDepth } from "./stoppolicy.mjs";

// ---------------------------------------------------------------------------
// Fit (swappable)
// ---------------------------------------------------------------------------

/**
 * Default fit: lexical cosine between the task and a tool's doc (name +
 * description + keywords). Zero-dependency and deterministic so the repo runs
 * anywhere. Swap the body for an embedding call to get semantic fit — the rest
 * of the pipeline is unchanged, fit is just a number in [0,1].
 * @param {string} task @param {import('./catalog.mjs').Tool} tool
 */
export function lexicalFit(task, tool) {
  const taskTf = termFreq(tokenize(task));
  const doc = [tool.name, tool.description, (tool.keywords || []).join(" ")].join(" ");
  return cosine(taskTf, termFreq(tokenize(doc)));
}

// ---------------------------------------------------------------------------
// Footprint
// ---------------------------------------------------------------------------

/**
 * Context footprint of loading a tool. The dominant, measurable term is the
 * tool's JSON-schema token count — the actual room it takes in the prompt —
 * nudged up for slow tools and sensitive ones (writes, secrets, PII).
 * @param {import('./catalog.mjs').Tool} tool @param {{latency:number, risk:number}} weights
 */
export function toolFootprint(tool, weights) {
  const schemaChars = JSON.stringify(tool.schema ?? {}).length;
  const schemaTokens = Math.max(1, Math.round(schemaChars / 4));
  const latencyPenalty = (weights.latency || 0) * (tool.latencyMs || 0) / 1000;
  const riskPenalty = (weights.risk || 0) * (tool.risk || 0);
  return { schemaTokens, latencyPenalty, riskPenalty, total: schemaTokens + latencyPenalty + riskPenalty };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RankConfig
 * @property {number} lambda     How hard footprint counts against a tool.
 * @property {number} worthFloor Minimum worth to board a tool past the minimum.
 * @property {number} fitFloor   Minimum lexical fit to board — unless the learner
 *                               has earned the tool a place (bypasses this).
 * @property {number} gamma      Weight on the learner's predicted payoff.
 * @property {number} explore    Weight on the learner's uncertainty bonus.
 * @property {number} budgetTokens Hard cap on total schema tokens boarded.
 * @property {number} minTools   Always board at least this many.
 * @property {number} maxTools   Never board more than this many.
 * @property {{latency:number, risk:number}} weights
 * @property {(task:string, tool:import('./catalog.mjs').Tool)=>number} [fit]
 */

/** @type {RankConfig} */
export const DEFAULT_CONFIG = {
  lambda: 0.13,
  worthFloor: 0.02,
  fitFloor: 0.18,
  gamma: 0.4,
  explore: 0.03,
  budgetTokens: 900,
  minTools: 1,
  maxTools: 6,
  weights: { latency: 0.08, risk: 18 },
};

/**
 * Score, rank, and find the gate line.
 * @param {string} task
 * @param {import('./catalog.mjs').Tool[]} catalog
 * @param {Partial<RankConfig>} [overrides]
 * @param {{ pin?:string[], exclude?:string[] }} [userOverrides]
 * @param {import('./learner.mjs').Bandit|null} [bandit] learned preferences
 * @param {object|null} [stopPolicy] learned cost-aware stop policy (from train-stop). When present it
 *   chooses the acquisition depth instead of the fixed worth floor.
 */
export function decide(task, catalog, overrides = {}, userOverrides = {}, bandit = null, stopPolicy = null) {
  const cfg = { ...DEFAULT_CONFIG, ...overrides, weights: { ...DEFAULT_CONFIG.weights, ...(overrides.weights || {}) } };
  const fitFn = cfg.fit || lexicalFit;
  const pinned = new Set(userOverrides.pin || []);
  const excluded = new Set(userOverrides.exclude || []);

  // 1. Score candidates: fit, footprint, and (if we've learned anything) the
  //    bandit's predicted payoff + uncertainty for this task.
  const base = catalog.map((tool) => {
    const fit = fitFn(task, tool);
    const footprint = toolFootprint(tool, cfg.weights);
    const b = bandit ? bandit.score(tool.name, task) : { mean: 0, bonus: 0 };
    return { tool, fit, footprint, learned: cfg.gamma * b.mean, explore: cfg.explore * b.bonus };
  });
  const avgFootprint = base.reduce((s, x) => s + x.footprint.total, 0) / (base.length || 1);
  const scored = base.map((x) => {
    const normFootprint = avgFootprint > 0 ? x.footprint.total / avgFootprint : 0;
    const worth = x.fit - cfg.lambda * normFootprint + x.learned + x.explore;
    return { ...x, worth };
  });

  // 2. Rank by worth (fit adjusted for footprint and what the learner knows),
  //    so board/hold can actually reorder — a broad but wrong tool that merely
  //    has high raw fit gets demoted once you've held it. Pinned tools jump the queue.
  scored.sort((a, b) => {
    const ap = pinned.has(a.tool.name) ? 1 : 0, bp = pinned.has(b.tool.name) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return b.worth - a.worth;
  });

  // 3. Choose which prefix to board. With a learned stop policy, the cutoff is
  //    decided by the trained cost-aware model; otherwise fall back to the
  //    fixed worth floor. Pins/excludes and min/max guardrails apply either way.
  const chosen = [], rejected = [];
  let spent = 0, stopReason = "exhausted-catalog", cutoffWorth = null, firstRejectedWorth = null;

  if (stopPolicy) {
    const scores = scored.map((s) => s.fit);
    const rawCosts = scored.map((s) => s.footprint.schemaTokens);
    const meanC = rawCosts.reduce((a, b) => a + b, 0) / (rawCosts.length || 1) || 1;
    const costs = rawCosts.map((c) => c / meanC); // match the mean-1 cost scale the policy trained on
    const depth = stopDepth(stopPolicy, scores, costs, stopPolicy.lambda ?? 0.12, stopPolicy.gate ?? 0.5);
    scored.forEach((s, i) => {
      const isPinned = pinned.has(s.tool.name);
      const isExcluded = excluded.has(s.tool.name);
      let include = isExcluded ? false : isPinned ? true : i < depth;
      if (include && chosen.length >= cfg.maxTools && !isPinned) include = false;
      if (!include && !isExcluded && chosen.length < cfg.minTools) include = true; // never starve
      if (include) { chosen.push({ ...s, reason: isPinned ? "user-pinned" : (s.learned > 0.02 ? "learned" : "boarded") }); spent += s.footprint.schemaTokens; }
      else rejected.push({ ...s, reason: isExcluded ? "user-excluded" : "beyond-stop" });
    });
    stopReason = "learned-stop";
  } else {
  for (const s of scored) {
    const isPinned = pinned.has(s.tool.name);
    if (excluded.has(s.tool.name)) { rejected.push({ ...s, reason: "user-excluded" }); continue; }
    const withinMin = chosen.length < cfg.minTools;
    const overMax = chosen.length >= cfg.maxTools;
    const overBudget = spent + s.footprint.schemaTokens > cfg.budgetTokens;
    const weakFit = s.fit < cfg.fitFloor && s.learned <= 0.02; // learner can override
    const notWorthIt = s.worth < cfg.worthFloor;
    let include;
    if (isPinned) include = true;
    else if (overMax) { include = false; stopReason = "max-tools"; }
    else if (withinMin) include = true;
    else if (weakFit) { include = false; stopReason = "weak-fit"; }
    else if (overBudget) { include = false; stopReason = "budget"; }
    else if (notWorthIt) { include = false; stopReason = "not-worth-it"; }
    else include = true;

    if (include) {
      const reason = isPinned ? "user-pinned" : withinMin ? "min-tools" : (s.learned > 0.02 ? "learned" : "worth-it");
      chosen.push({ ...s, reason });
      spent += s.footprint.schemaTokens;
      cutoffWorth = s.worth;
    } else {
      if (firstRejectedWorth === null) firstRejectedWorth = s.worth;
      rejected.push({ ...s, reason: stopReason });
    }
  }
  }

  // 4. Confidence in the gate line: a narrow worth-gap = an arbitrary cut, so
  //    the UI should widen / ask rather than fake certainty.
  let confidence = 1;
  if (cutoffWorth != null && firstRejectedWorth != null) {
    confidence = Math.max(0, Math.min(1, (cutoffWorth - firstRejectedWorth) * 6));
  }

  const loadAllTokens = scored.reduce((s, x) => s + x.footprint.schemaTokens, 0);
  return {
    task, config: cfg,
    userOverrides: { pin: [...pinned], exclude: [...excluded] },
    chosen, rejected,
    summary: {
      loaded: chosen.length, total: scored.length,
      tokensLoaded: spent, tokensIfLoadAll: loadAllTokens, tokensSaved: loadAllTokens - spent,
      pctSaved: loadAllTokens ? Math.round(((loadAllTokens - spent) / loadAllTokens) * 100) : 0,
      stopReason, confidence: Number(confidence.toFixed(2)), lowConfidence: confidence < 0.35,
    },
    generatedAt: new Date().toISOString(),
  };
}
