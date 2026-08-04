/**
 * Bandit persistence. Loads/saves the LinUCB state so learning carries across
 * sessions and processes. The panel keeps an equivalent copy in the browser
 * (localStorage) and can export a file in this same shape to drop in here.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Bandit } from "./learner.mjs";

/** @returns {Bandit} */
export function loadBandit(path) {
  if (!existsSync(path)) return new Bandit();
  try { return Bandit.fromJSON(JSON.parse(readFileSync(path, "utf8"))); }
  catch { return new Bandit(); }
}

export function saveBandit(path, bandit) {
  writeFileSync(path, JSON.stringify(bandit.toJSON(), null, 2));
}
