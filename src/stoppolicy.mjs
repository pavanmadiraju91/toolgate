/**
 * Learned stop policy
 * -------------------
 * Turns a ranked list of candidate tools into an acquisition depth: how far
 * down the ranking to board before handing the prefix to the agent.
 *
 * The point: a relevance ranking tells you the ORDER, not HOW MANY. Picking the
 * cutoff with a score threshold is provably wrong once tools cost different
 * amounts of context — a cheap-but-useless tool and an expensive-but-essential
 * one can't be separated by a score line. So we learn the stop, cost and all.
 *
 * How it's trained (offline, on logged tasks whose required tool set is known):
 *   payoff  U(A_t) = sufficiency(A_t) − λ·Σ cost      // did the prefix cover the task, minus cost
 *   gap     Δ(t)   = max_{k>t} U(A_k) − U(A_t)         // best you could still do by continuing
 *   label   y*(t)  = 1 if Δ(t) ≤ 0  (stopping here is at least as good as continuing)
 *   weight  w(t)   = |Δ(t)| + ε                        // mistakes that cost more payoff matter more
 * Fit a regret-weighted, L2-regularized logistic model p_stop = σ(θ·φ) on
 * deployment-time features φ (scores, costs, value-per-cost, progress, remaining
 * net value, λ — never the required set). Deploy: scan depths, stop at first
 * p_stop ≥ 0.5. No LLM fine-tuning; this is a pre-execution layer.
 */

const EPS = 1e-4;

/** Sufficiency of a prefix of length t: does it contain every required tool? */
function sufficient(requiredMask, t) {
  for (let i = 0; i < requiredMask.length; i++) {
    if (requiredMask[i] && i >= t) return 0; // a required tool sits beyond the prefix
  }
  return 1;
}

/** Payoff of the depth-t prefix. scores/costs are ranked (desc by score). */
export function payoff(costs, requiredMask, t, lambda) {
  let cum = 0;
  for (let i = 0; i < t; i++) cum += costs[i];
  return sufficient(requiredMask, t) - lambda * cum;
}

/**
 * Deployment features at state S_t (prefix of t tools, next candidate at index t).
 * Uses only what's visible before execution — never the required set.
 *
 * Ten compact, interpretable marginal score-cost and prefix-progress signals.
 * The design goal: capture the one-step "is the next tool worth its cost, given
 * what's already taken and what's still ahead" decision without ever leaking the
 * answer key. Concretely:
 *   1. progress t/m
 *   2. next score
 *   3. next score / next cost      (marginal value per unit cost)
 *   4. next-score gap to the second remaining candidate
 *   5. remaining maximum score
 *   6. normalized remaining-score sum
 *   7. remaining score / remaining cost (ratio of sums)
 *   8. normalized selected cost
 *   9. lambda x next cost
 *  10. next-high-cost indicator
 * They deliberately omit tool identity, offline labels, required-set size, and
 * any outcome-derived information.
 */
export function features(scores, costs, t, lambda) {
  const m = scores.length;
  const nextScore = t < m ? scores[t] : 0;
  const nextCost = t < m ? costs[t] : 1;
  const secondScore = t + 1 < m ? scores[t + 1] : 0;

  let remScoreSum = 0, remCostSum = 0, remMax = 0;
  for (let i = t; i < m; i++) { remScoreSum += scores[i]; remCostSum += costs[i]; if (scores[i] > remMax) remMax = scores[i]; }
  let selCost = 0, totalCost = 0;
  for (let i = 0; i < m; i++) { totalCost += costs[i]; if (i < t) selCost += costs[i]; }
  const meanCost = m ? totalCost / m : 0;

  return [
    m ? t / m : 0,                                   // 1. progress
    nextScore,                                       // 2. next score
    nextCost > 0 ? nextScore / nextCost : nextScore, // 3. next score / next cost
    nextScore - secondScore,                         // 4. gap to second remaining candidate
    remMax,                                          // 5. remaining max score
    m ? remScoreSum / m : 0,                         // 6. normalized remaining-score sum
    remCostSum > 0 ? remScoreSum / remCostSum : 0,   // 7. remaining score / remaining cost
    totalCost > 0 ? selCost / totalCost : 0,         // 8. normalized selected cost
    lambda * nextCost,                               // 9. lambda x next cost
    t < m && costs[t] > meanCost ? 1 : 0,            // 10. next-high-cost indicator
  ];
}

const NF = 10; // feature count

// --- weighted, L2-regularized logistic regression (batch gradient descent) ---
const sig = (z) => 1 / (1 + Math.exp(-z));

function standardize(rows) {
  const n = rows.length, d = rows[0].length;
  const mean = new Array(d).fill(0), std = new Array(d).fill(0);
  for (const r of rows) for (let j = 0; j < d; j++) mean[j] += r[j] / n;
  for (const r of rows) for (let j = 0; j < d; j++) std[j] += (r[j] - mean[j]) ** 2 / n;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;
  return { mean, std };
}
const applyStd = (r, s) => r.map((v, j) => (v - s.mean[j]) / s.std[j]);

/**
 * Train the stop policy.
 * @param {{X:number[][], y:number[], w:number[]}} data pooled prefix examples
 * @param {{l2?:number, lr?:number, iters?:number}} [opts]
 */
export function train(data, opts = {}) {
  const { l2 = 1e-2, lr = 0.3, iters = 4000 } = opts;
  const std = standardize(data.X);
  const X = data.X.map((r) => applyStd(r, std));
  const n = X.length, d = NF;
  let theta = new Array(d + 1).fill(0); // theta[0] = bias
  const W = data.w.reduce((a, b) => a + b, 0) || 1;
  for (let it = 0; it < iters; it++) {
    const g = new Array(d + 1).fill(0);
    for (let i = 0; i < n; i++) {
      const xi = X[i];
      let z = theta[0]; for (let j = 0; j < d; j++) z += theta[j + 1] * xi[j];
      const err = (sig(z) - data.y[i]) * data.w[i];
      g[0] += err; for (let j = 0; j < d; j++) g[j + 1] += err * xi[j];
    }
    for (let j = 0; j <= d; j++) g[j] /= W;
    for (let j = 1; j <= d; j++) g[j] += l2 * theta[j]; // don't regularize bias
    for (let j = 0; j <= d; j++) theta[j] -= lr * g[j];
  }
  return { theta, std };
}

/** p_stop at state S_t under a trained policy. */
export function pStop(policy, scores, costs, t, lambda) {
  const x = applyStd(features(scores, costs, t, lambda), policy.std);
  let z = policy.theta[0]; for (let j = 0; j < NF; j++) z += policy.theta[j + 1] * x[j];
  return sig(z);
}

/** Deploy: scan depths, stop at first p_stop ≥ gate (default 0.5). Returns acquisition depth. */
export function stopDepth(policy, scores, costs, lambda, gate = 0.5) {
  const m = scores.length;
  for (let t = 0; t <= m; t++) {
    if (t === m) return m;
    if (pStop(policy, scores, costs, t, lambda) >= gate) return t;
  }
  return m;
}

/** Build pooled training examples from a labeled dataset. */
export function buildExamples(dataset, lambda) {
  const X = [], y = [], w = [];
  for (const task of dataset) {
    const m = task.scores.length;
    const U = []; for (let t = 0; t <= m; t++) U.push(payoff(task.costs, task.requiredMask, t, lambda));
    for (let t = 0; t < m; t++) {
      let bestCont = -Infinity; for (let k = t + 1; k <= m; k++) bestCont = Math.max(bestCont, U[k]);
      const gap = bestCont - U[t];          // Δ(t): how much better continuing could be
      X.push(features(task.scores, task.costs, t, lambda));
      y.push(gap <= 0 ? 1 : 0);             // stop is optimal when continuing can't beat it
      w.push(Math.abs(gap) + EPS);
    }
  }
  return { X, y, w };
}

// --- baselines (each returns an acquisition depth) ---
export const baselines = {
  scoreThreshold: (scores, costs, lambda, tau) => { // stop at first tool below score τ
    for (let t = 0; t < scores.length; t++) if (scores[t] < tau) return t; return scores.length;
  },
  scorePerCost: (scores, costs, lambda, tau) => {   // stop at first value-per-cost below τ
    for (let t = 0; t < scores.length; t++) if (scores[t] / (costs[t] + 1) < tau) return t; return scores.length;
  },
  fixedK: (scores, costs, lambda, k) => Math.min(k, scores.length),
  oracle: (scores, costs, requiredMask, lambda) => {  // uses the required set — upper bound only
    let best = 0, bestU = -Infinity;
    for (let t = 0; t <= scores.length; t++) { const u = payoff(costs, requiredMask, t, lambda); if (u > bestU) { bestU = u; best = t; } }
    return best;
  },
};
