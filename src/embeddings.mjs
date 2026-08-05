/**
 * Semantic fit via sentence embeddings.
 * -------------------------------------
 * Lexical fit only matches shared words, so "what's tagged to me" never reaches
 * a tool described as "Search Confluence (CQL)". This swaps in real embeddings:
 * a local sentence-transformer (all-MiniLM-L6-v2) that scores tools by meaning.
 *
 * Best-practice choices:
 *   - Local model (no API key, nothing leaves the machine) — this broker handles
 *     work data, so on-device embedding is the safe default.
 *   - Disk-cached vectors keyed by (model, text): each tool doc is embedded once.
 *   - Graceful fallback: if the optional dep/model isn't available, callers fall
 *     back to lexical fit, so the zero-install path still runs.
 *
 * Override the model with TOOLGATE_EMBED_MODEL. The dependency is optional:
 *   npm install @huggingface/transformers
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = process.env.TOOLGATE_EMBED_MODEL || "Xenova/all-MiniLM-L6-v2";
const CACHE_PATH = join(root, "config", "embeddings.cache.json");

let _extractor = null;      // lazy pipeline
let _extractorTried = false;
let _cache = null;          // { model, vectors: { hash: number[] } }
let _dirty = false;

const hash = (s) => createHash("sha1").update(s).digest("hex");

function loadCache() {
  if (_cache) return _cache;
  try {
    if (existsSync(CACHE_PATH)) {
      const c = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
      if (c.model === MODEL) { _cache = c; return _cache; }
    }
  } catch { /* ignore */ }
  _cache = { model: MODEL, vectors: {} };
  return _cache;
}
export function saveCache() {
  if (!_dirty || !_cache) return;
  try { mkdirSync(dirname(CACHE_PATH), { recursive: true }); writeFileSync(CACHE_PATH, JSON.stringify(_cache)); _dirty = false; } catch { /* ignore */ }
}

/** Lazily load the embedding pipeline; returns null if the dep/model is unavailable. */
async function getExtractor() {
  if (_extractorTried) return _extractor;
  _extractorTried = true;
  try {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.allowRemoteModels = true; // download once, then cached under node_modules/.cache
    _extractor = await pipeline("feature-extraction", MODEL);
  } catch (e) {
    console.error(`[toolgate] embeddings unavailable (${String(e.message || e).slice(0, 80)}); using lexical fit`);
    _extractor = null;
  }
  return _extractor;
}

/** Is semantic fit usable right now? */
export async function embeddingsAvailable() {
  return (await getExtractor()) !== null;
}

/** Embed one string to a normalized vector (cached). Returns null if unavailable. */
export async function embed(text) {
  const cache = loadCache();
  const key = hash(text);
  if (cache.vectors[key]) return cache.vectors[key];
  const extractor = await getExtractor();
  if (!extractor) return null;
  const out = await extractor(text, { pooling: "mean", normalize: true });
  const vec = Array.from(out.data);
  cache.vectors[key] = vec; _dirty = true;
  return vec;
}

/** Embed many strings, reusing cache; writes the cache once at the end. */
export async function embedMany(texts) {
  const out = [];
  for (const t of texts) out.push(await embed(t));
  saveCache();
  return out;
}

export function cosine(a, b) {
  if (!a || !b) return 0;
  let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d; // vectors are already L2-normalized
}

/** The text we embed for a tool — same doc lexical fit uses (name + desc + keywords). */
export function toolDoc(tool) {
  return [tool.name, tool.description, (tool.keywords || []).join(" ")].join(" ");
}

/**
 * Build a synchronous fit(task, tool) for one task using cached embeddings.
 * Embeds the whole catalog (once, cached) and the task, then returns a closure
 * doing cosine similarity. Returns null if embeddings are unavailable — callers
 * should fall back to lexicalFit.
 * @param {import('./catalog.mjs').Tool[]} catalog
 * @param {string} task
 */
export async function semanticFitFor(catalog, task) {
  if (!(await embeddingsAvailable())) return null;
  const docs = catalog.map(toolDoc);
  const vecs = await embedMany([task, ...docs]);
  const taskVec = vecs[0];
  const byName = new Map();
  catalog.forEach((t, i) => byName.set(t.name, vecs[i + 1]));
  return (t, tool) => cosine(taskVec, byName.get(tool.name));
}
