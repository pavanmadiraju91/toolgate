/**
 * LinUCB — a linear contextual bandit for learning which tools to board.
 * ---------------------------------------------------------------------
 * Chosen over a hand-rolled heuristic because it's the established fit for
 * "learn to shortlist items from implicit accept/reject feedback" with
 * cold-start, few examples, sparse text features, and interpretability:
 *
 *   - each tool is an arm with its own linear model over task features;
 *   - board = reward 1, hold = reward 0;
 *   - it predicts a mean payoff AND an uncertainty (confidence) bonus, so
 *     unseen-but-plausible tools get *explored* rather than silently buried.
 *
 * The uncertainty bonus is not incidental — it feeds Toolgate's "unsure →
 * widen the gate" behavior directly, which is the whole point of the UX.
 *
 * Pure JS (no deps), so the Node ranker and the browser panel share one
 * implementation and learn identically. Serializable for persistence.
 */
import { tokenize } from "./text.mjs";

export const DIM = 24;        // feature dimension (hashed task terms + bias)
const ALPHA = 1.0;            // exploration scale on the confidence bonus

/** Hash a task into a unit-norm feature vector. @param {string} task */
export function featurize(task, dim = DIM) {
  const x = new Float64Array(dim);
  x[dim - 1] = 1; // bias term
  for (const t of tokenize(task)) {
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
    const idx = Math.abs(h) % (dim - 1);
    x[idx] += 1;
  }
  let norm = 0; for (let i = 0; i < dim; i++) norm += x[i] * x[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) x[i] /= norm;
  return x;
}

/** Fresh per-arm state: A^-1 = I, b = 0. */
function newArm(dim = DIM) {
  const Ainv = new Float64Array(dim * dim);
  for (let i = 0; i < dim; i++) Ainv[i * dim + i] = 1;
  return { Ainv: Array.from(Ainv), b: new Array(dim).fill(0) };
}

function matVec(M, v, dim) {
  const out = new Float64Array(dim);
  for (let i = 0; i < dim; i++) { let s = 0; for (let j = 0; j < dim; j++) s += M[i * dim + j] * v[j]; out[i] = s; }
  return out;
}
function dot(a, b, dim) { let s = 0; for (let i = 0; i < dim; i++) s += a[i] * b[i]; return s; }

/**
 * A bandit holds one arm per tool, created lazily. Serialize with toJSON /
 * restore with fromJSON so learning persists across sessions and processes.
 */
export class Bandit {
  constructor(arms = {}, dim = DIM) { this.arms = arms; this.dim = dim; }
  static fromJSON(obj) { return new Bandit(obj?.arms || {}, obj?.dim || DIM); }
  toJSON() { return { dim: this.dim, arms: this.arms }; }

  arm(tool) { return (this.arms[tool] ||= newArm(this.dim)); }

  /** Predicted payoff (mean) and uncertainty (bonus) for a tool on a task. */
  score(tool, task) {
    const d = this.dim, a = this.arm(tool), x = featurize(task, d);
    const theta = matVec(a.Ainv, a.b, d);
    const mean = dot(theta, x, d);
    const Ax = matVec(a.Ainv, x, d);
    const bonus = Math.sqrt(Math.max(0, dot(x, Ax, d)));
    return { mean, bonus: ALPHA * bonus };
  }

  /** Record feedback: reward 1 when the human boards a tool, 0 when they hold it. */
  update(tool, task, reward) {
    const d = this.dim, a = this.arm(tool), x = featurize(task, d);
    const Ax = matVec(a.Ainv, x, d);
    const denom = 1 + dot(x, Ax, d);
    for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) a.Ainv[i * d + j] -= (Ax[i] * Ax[j]) / denom;
    for (let i = 0; i < d; i++) a.b[i] += reward * x[i];
    return this;
  }
}
