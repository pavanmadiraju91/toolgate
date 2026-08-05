# AGENTS.md

Toolgate is a design-study prototype: an MCP broker that ranks/shortlists an agent's tools by fit-vs-context-footprint, shown in a legibility panel. Read `README.md` and `docs/02-design.md` for the model.

## Stack & conventions
- Pure Node.js **ESM** (`"type": "module"`), all source is `.mjs`. No build step, no bundler, no transpile.
- **No test framework, no linter, no formatter** are configured. Don't invent `npm test`/`npm run lint` — they don't exist. Verify by running the CLIs below.
- Only dependency is `@modelcontextprotocol/sdk` (optional; needed solely for `broker`/`catalog`). Core ranker/learner/panel run with zero installs.

## Commands (from package.json)
- `npm run demo` — score sample tasks, write `panel/decisions.json`. Single task: `node src/demo.mjs "<task>"` with optional `--pin <tool>` / `--exclude <tool>` / `--all`.
- `npm run panel` — static server at `http://127.0.0.1:7799` (serves repo root so the panel can import `/src` modules). `npm run demo` must run first or the panel 404s.
- `npm run learn` — bandit board/hold demo.
- `npm run train-stop` — train the cost-aware stop policy, writes `config/stop-policy.json`. **Defaults to training on real mined history**; `--synthetic` uses the old generator (CI/ablation). A regret-identity numeric check prints each run (`max|err|` must be ~0).
- **Eval-set mining pipeline** (feeds `train-stop`): `npm run mine` → `eval/history/traces.jsonl` (parses Claude Code JSONL incl. subagent sidechains + opencode SQLite); `npm run label -- --judge opencode` → `eval/history/labeled.jsonl` (LLM judge for required set `G_x`, needs a working `opencode run` model — `anthropic/claude-opus-4-8-fast` works; sonnet/haiku hit a provider bug on some accounts); `npm run label` alone = zero-dep M3 heuristic only; `npm run dataset` prints dataset stats.
- `npm run catalog` — connect to real MCP servers and generate `config/catalog.generated.json`. Requires the SDK installed and reachable servers.
- `npm run broker` — run the MCP broker on stdio (what opencode connects to).
- `npm run broker-http` — same broker over MCP Streamable HTTP at `http://127.0.0.1:7800/mcp` (for URL-based connectors like SAP Joule). `PORT` overrides the port; `TOOLGATE_TOKEN` requires `Authorization: Bearer <token>`. Needs a public HTTPS tunnel for hosted clients.

## Architecture entrypoints
- `src/ranker.mjs` `decide(task, catalog, config, overrides, bandit, stopPolicy)` is the core; every CLI calls it.
- `src/stoppolicy.mjs` is the learned cost-aware stop. `features()` is the fixed 10-feature map (marginal score-cost + prefix-progress) — don't "simplify" it away; the ranker and training both depend on it. `buildExamples()` builds the regret-weighted training set (`ε=1e-4`).
- `src/broker.mjs` exposes exactly two MCP tools: `find_tools` and `run_tool`. `run_tool` forwards to real downstream servers via `src/mcpClients.mjs`. `buildServer()`/`loadDeps()` are shared with `src/broker-http.mjs` (Streamable HTTP transport, stateless, for URL connectors); `broker.mjs` only runs stdio when invoked directly (import.meta.url guard).
- `src/text.mjs` is the shared tokenizer — the ranker and `src/learner.mjs` (LinUCB bandit) must agree on features, so change tokenization here only.
- `src/embeddings.mjs` is semantic fit: a local sentence-transformer (all-MiniLM-L6-v2 via optional `@huggingface/transformers`) with a disk cache (`config/embeddings.cache.json`, gitignored) and graceful lexical fallback. `semanticFitFor(catalog, task)` returns a sync `fit(task,tool)` used by the broker and by `eval-dataset.mjs` (so the stop policy trains on the same scores it serves — no skew). No API keys; nothing leaves the machine. Don't reintroduce hand-maintained keyword synonyms — improve tool descriptions instead.
- Broker `find_tools` returns the semantic top-k shortlist by default; `TOOLGATE_STOP=1` applies the learned cost-aware stop instead (minimal single-prefix acquisition).
- Broker logging is pino (`src/logger.mjs`): every `find_tools`/`run_tool` is one JSON line to `eval/history/broker-log.jsonl` (override `TOOLGATE_LOG`) and to **stderr** — never stdout, which is the stdio MCP channel. Logs tool identity + outcome, not args/results; secret-ish fields are redacted. `LOG_LEVEL` tunes verbosity.
- Eval-mining seam: `src/mine-history.mjs` (harness → traces) → `src/label-required.mjs` (traces → labeled `G_x`) → `src/eval-dataset.mjs` (labeled → ranked `{scores,costs,requiredMask}`, candidates **scoped per task to the servers it touched**) → `src/train-stop.mjs`.
- File map is documented in `README.md` under "Architecture".

## Gotchas
- **Catalog fallback:** `broker.mjs` and `demo.mjs` prefer `config/catalog.generated.json` if present, else `config/catalog.example.json`. Deleting the generated file silently switches to the sample.
- **Gitignored/generated state** (not in repo): `config/learned.json`, `config/catalog.generated.json`, `config/ignore.json`, `eval/results/`. Don't assume they exist; regenerate via the commands above.
- **`src/mcpConfig.mjs` intentionally does NOT skip `enabled:false` servers** — daily-drive mode disables them for opencode so only Toolgate connects, but Toolgate still needs their defs to broker them. It skips any server whose name matches `/toolgate/`.
- Config resolution order for opencode servers: `TOOLGATE_OPENCODE_CONFIG` env → `./opencode.json` → `~/.config/opencode/opencode.json`. Env vars `TOOLGATE_OPENCODE_CONFIG` and `TOOLGATE_IGNORE` (comma list) tune it.
- **Policy dials** live in `config/toolgate.config.json` (`lambda`, `worthFloor`, `fitFloor`, `budgetTokens`, weights). Tune `lambda` per `docs/03-eval.md`; higher = shorter shortlist.
- Fit scoring uses local semantic embeddings (`src/embeddings.mjs`) with a lexical fallback when the optional model isn't installed. The old pure-lexical path misses synonyms; that's why embeddings are the default.
