#!/usr/bin/env node
/**
 * Toolgate demo CLI
 * -----------------
 * Runs a task through the ranker and writes a decision record the legibility
 * panel can render. This is the fastest way to *see* Toolgate think.
 *
 * Usage:
 *   node src/demo.mjs "draft a jira ticket from this slack thread"
 *   node src/demo.mjs "build a react component from a figma design" --pin ds.getComponent
 *   node src/demo.mjs --all            # write a bundle of sample tasks for the panel
 *
 * Output: panel/decisions.json  (open panel/index.html to view it)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCatalog } from "./catalog.mjs";
import { decide } from "./ranker.mjs";
import { loadBandit } from "./prefs.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const generated = join(root, "config", "catalog.generated.json");
const catalogPath = existsSync(generated) ? generated : join(root, "config", "catalog.example.json");
const catalog = loadCatalog(catalogPath);
const config = JSON.parse(readFileSync(join(root, "config", "toolgate.config.json"), "utf8"));
const bandit = loadBandit(join(root, "config", "learned.json")); // empty until you teach it

// Ten tasks from a real design-engineer's week, chosen to show the range:
// clear single-domain, genuine multi-tool, research, write-heavy/risky,
// cross-domain, browser work, and one deliberately vague prompt.
const SAMPLE_TASKS = [
  "Turn this Figma frame into a React component using our design-system tokens",
  "Summarize the unread messages in the design-critique Slack channel and post a recap",
  "Find the Jira tickets assigned to me that are still open and comment a status update",
  "Read the latest React Server Components docs and current caching best practices",
  "Check what's on my calendar tomorrow and email the team an agenda",
  "Reproduce the flaky login bug by driving the sign-in flow in the browser",
  "Do the needful for the thing on the project",
  "Generate three onboarding screen mockups for the mobile app",
  "Research competitor pricing pages and capture their hero sections",
  "Draft release notes from the Jira tickets closed this sprint",
];

function parseArgs(argv) {
  const args = { pin: [], exclude: [], all: false, task: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") args.all = true;
    else if (a === "--pin") args.pin.push(argv[++i]);
    else if (a === "--exclude") args.exclude.push(argv[++i]);
    else if (!a.startsWith("--")) args.task = a;
  }
  return args;
}

function run(task, userOverrides) {
  return decide(task, catalog, config, userOverrides, bandit);
}

const args = parseArgs(process.argv.slice(2));
const decisions = [];

if (args.all || !args.task) {
  for (const t of SAMPLE_TASKS) decisions.push(run(t, {}));
} else {
  decisions.push(run(args.task, { pin: args.pin, exclude: args.exclude }));
}

mkdirSync(join(root, "panel"), { recursive: true });
const outPath = join(root, "panel", "decisions.json");
writeFileSync(outPath, JSON.stringify(decisions, null, 2));

// Console summary — legible in the terminal too.
for (const d of decisions) {
  const s = d.summary;
  console.log("\n\u2500\u2500\u2500 " + d.task);
  console.log(
    `  loaded ${s.loaded}/${s.total} tools | ${s.tokensLoaded} tok ` +
      `(saved ${s.pctSaved}% vs load-all) | stop: ${s.stopReason} | ` +
      `confidence ${s.confidence}${s.lowConfidence ? "  \u26a0 LOW \u2014 UI should widen/ask" : ""}`
  );
  for (const c of d.chosen) {
    console.log(`    \u2713 ${c.tool.name.padEnd(26)} fit=${c.fit.toFixed(3)} footprint=${c.footprint.total.toFixed(0)} (${c.reason})`);
  }
  const near = d.rejected.slice(0, 2);
  for (const rj of near) {
    console.log(`    \u00b7 ${rj.tool.name.padEnd(26)} fit=${rj.fit.toFixed(3)} footprint=${rj.footprint.total.toFixed(0)} (dropped: ${rj.reason})`);
  }
}

console.log(`\nWrote ${decisions.length} decision(s) -> ${outPath}`);
console.log("Open panel/index.html in a browser (or run: npm run panel).");
