/**
 * Shared text utilities (no dependencies). Imported by both the ranker and the
 * learner so the task is tokenized identically everywhere.
 */

const STOPWORDS = new Set(
  ("a an the of to for and or in on with using use want need get set my me i " +
   "this that these those is are be do does how what which them it its via " +
   "please can could would should from into over under by at as your you the")
    .split(" ")
);

/** @param {string} text */
export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Term-frequency map. @param {string[]} tokens */
export function termFreq(tokens) {
  /** @type {Record<string, number>} */
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return tf;
}

/** Cosine similarity between two TF maps. */
export function cosine(a, b) {
  let dot = 0;
  for (const k in a) if (b[k]) dot += a[k] * b[k];
  const mag = (m) => Math.sqrt(Object.values(m).reduce((s, v) => s + v * v, 0));
  const denom = mag(a) * mag(b);
  return denom === 0 ? 0 : dot / denom;
}
