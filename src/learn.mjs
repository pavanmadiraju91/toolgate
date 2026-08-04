#!/usr/bin/env node
/**
 * Self-learning demo
 * ------------------
 * Shows the LinUCB learner changing Toolgate's mind. We pick a task where a
 * useful tool normally sits just *below* the gate (its footprint outweighs its
 * lexical fit), then "board" it a few times — the human teaching Toolgate that
 * this tool matters for this kind of task — and watch it clear the gate on its
 * own, with no manual pin.
 *
 * Run:  npm run learn
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCatalog } from "./catalog.mjs";
import { decide } from "./ranker.mjs";
import { Bandit } from "./learner.mjs";
import { saveBandit } from "./prefs.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const catalog = loadCatalog(join(root, "config", "catalog.example.json"));
const config = JSON.parse(readFileSync(join(root, "config", "toolgate.config.json"), "utf8"));

const TASK = "Reproduce the flaky login bug by driving the sign-in flow in the browser";
const TOOL = "browserclaw.act"; // relevant (you must drive the page) but starts held: heavy schema, weak lexical fit

const bandit = new Bandit();
const boarded = (rec) => rec.chosen.some((c) => c.tool.name === TOOL);

console.log(`Task: ${TASK}\nTeaching signal: board "${TOOL}" whenever it shows up.\n`);
for (let round = 0; round <= 6; round++) {
  const rec = decide(TASK, catalog, config, {}, bandit);
  const onList = boarded(rec);
  console.log(`after ${String(round).padStart(2)} lessons  ->  ${TOOL} ${onList ? "BOARDS on its own \u2713" : "held below the gate"}  (boarded ${rec.summary.loaded}/${rec.summary.total})`);
  if (onList && round > 0) break;
  bandit.update(TOOL, TASK, 1); // the human boards it: reward = 1
}

saveBandit(join(root, "config", "learned.json"), bandit);
console.log(`\nSaved learned state -> config/learned.json (demo.mjs and the broker now pick it up).`);
