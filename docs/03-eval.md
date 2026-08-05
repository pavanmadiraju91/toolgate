# 03 · Evaluation

A prototype earns belief, not a leaderboard spot. So this is a small, honest look at where Toolgate helps, where it doesn't, and what I'd measure next.

## Method

Ten tasks from a real design-engineer's week: a couple of clear single-domain ones, a few genuine multi-tool ones, some research, one write-heavy, one browser task, and one deliberately vague prompt. Each is scored against a 16-tool sample catalog. Full records live in `panel/decisions.json` and render in the panel. To reproduce:

```bash
npm run demo
```

I looked at two things. Efficiency (how much context got saved versus loading everything) and, the one that actually matters for a human-in-the-loop tool, judgment (did it board the right tools, and did its confidence track reality?).

## Results

| Task | Boarded | Context saved | Confidence | Read |
|------|:------:|:-----:|:----------:|------|
| Figma frame to React component | 4/16 | 79% | 0.60 | the four real design tools, nothing else |
| Summarize Slack channel, post recap | 2/16 | 87% | 1.0 | search + write |
| My open Jira tickets, comment an update | 2/16 | 84% | 1.0 | search + write |
| Latest RSC caching docs | 1/16 | 95% | 0.27 | weak lexical signal, and it's unsure |
| Calendar tomorrow, email an agenda | 1/16 | 97% | 1.0 | boards calendar, misses email |
| Reproduce the flaky login in a browser | 1/16 | 95% | 0.48 | boards snapshot, misses `act` |
| "Do the needful for the thing" | 1/16 | 95% | 0.0 | nonsense in, low confidence out |
| Generate onboarding mockups | 1/16 | 93% | 1.0 | the screen generator |
| Research competitor pricing pages | 1/16 | 95% | 0.01 | weak signal, and it's unsure |
| Draft release notes from closed tickets | 1/16 | 95% | 1.0 | Jira search |

### What worked

Savings were large and the lists stayed clean: 79 to 97 percent fewer tool definitions loaded. Once I added the relevance floor, the padding disappeared. The Figma task boards exactly the four design tools and drops the UI-mockup generator instead of boarding it just because it's cheap. Slack and Jira each board their search-and-write pair and stop. And on the hard cases, the confidence tracked reality: the vague task landed at 0, the two low-signal research tasks at 0.27 and 0.01, which is exactly where a human should be pulled in.

### What didn't (and why it's the interesting part)

There are two confident misses, both from lexical fit. "Email the team" never matched `outlook.sendEmail`, and "driving the sign-in flow" never matched `browserclaw.act`, because plain word overlap doesn't know that *email* means *sendEmail* or *drive* means *act*. Confidence stayed high because the cut was clean, not because the fit was right. Confidence measures how sharp the gate line is, not whether fit got the answer.

This is exactly what the learner and the override are for. Board `browserclaw.act` once on that task and it clears the gate on its own next time. `npm run learn` shows precisely that: a held tool boarding itself after feedback. A confident miss is survivable when fixing it takes one click and teaches the system for next time.

## The two dials

`fitFloor` is the relevance a tool needs to board on its own. Raise it and the lists get more conservative; the learner can still override it for tools it has learned matter. `λ` is how hard footprint counts, which sets the overall temperament of the shortlist.

Ground both from your own logs. Treat the tools the agent actually called as "should have boarded," pick values that keep those on the shortlist under a context budget, and watch one guardrail: if precision (called ÷ boarded) is high but outcomes drop, ease off.

## If I took this further

Swapping lexical fit for embeddings is a one-function change and would resolve both confident misses. Confidence should also factor in how low the absolute fit is, so "nothing matched well" reads as uncertain even when the cut is clean. The learner already turns overrides into signal (LinUCB, described in [02-design](02-design.md)); the next step is decay and per-context memory so it personalizes without ossifying. And the real question a prototype like this exists to set up: does seeing the manifest actually change how much people trust and supervise the agent? That needs a user study.

## The cost-aware stop: learned, on real history

The "how many tools" question is answered by a learned cost-aware stop — see the [README](../README.md) for the objective. What matters here: it is trained and evaluated on **real mined tasks, not synthetic ones**. The methodology is a reusable pattern for anyone who wants to build an eval set from their own agent traffic.

### Building the eval set from agent history

1. **Mine** (`npm run mine`) — parse Claude Code session JSONL (`~/.claude/projects/**`, *including subagent sidechains*, where MCP-heavy work often lives) and the opencode SQLite store. Normalize each tool call (`mcp__server__tool` / `server_tool`) onto Toolgate's catalog. One session → one trace with the task text, the tools it used, and a compact transcript. Private text stays local (`eval/history/` is gitignored). Yield: **126 tasks** across all 10 catalog servers.
2. **Label** (`npm run label -- --judge opencode`) — recover the required-tool set `G_x`. Agents overcall, so "called" ≠ "required". Two methods:
   - **M2, LLM judge (primary):** a model sees the task + transcript + the *current* catalog tools of the servers the task touched, and prunes the used set to what was necessary (adding a renamed equivalent when a server was upgraded since). Rename-proof, since it picks from today's catalog. The framing keeps it on read-only necessity: which tools an agent had to consult before it could act.
   - **M3, consumption (cross-check):** a tool is required if it was called and returned successfully. Zero-dependency, deterministic, but inherits overcalling.
   Mean M2/M3 Jaccard ≈ 0.54 — the gap *is* the overcalling this whole layer exists to trim. A hand-verified `gold.jsonl` (template via `npm run label -- --make-gold 20`) scores label quality (P/R/F1) when present; human gold is the pending calibration step.
3. **Score & train** (`npm run train-stop`) — for each task, candidates are scoped to the servers it touched (~18 tools on average — a task's "domain" — rather than a global 105-tool catalog where required tools sink to median rank 28). Scores are Toolgate's real ranker fit; costs are real schema-token footprints (heterogeneous). The stop trains on a 60/20/20 split.

### Result (mean test payoff, higher is better)

| λ | learned stop | score threshold | score-per-cost | fixed-k | full access | oracle |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| 0.12 | **0.288** | 0.240 | 0.240 | 0.211 | −1.48 | 0.466 |
| 0.20 | 0.217 | 0.240 | 0.240 | 0.240 | −3.14 | 0.389 |

At λ=0.12 the learned stop wins by ~20% and reaches 52% sufficiency vs 24%: the score-only baselines collapse to acquiring *nothing* because, once tools cost different amounts, no single score line separates a cheap-useless tool from an expensive-essential one — while the learned stop acquires ~2 tools. The **regret-identity** check runs numerically each run (`max|err|=0`), confirming the training target stays aligned with the payoff it's meant to optimize.

### Honest caveats

- **Ranker-bound at high pressure.** At λ=0.20, the learned stop (0.217) trails the trivial "take nothing" baseline (0.240): with lexical fit it can't reliably rank the *right* tools to the top, so under heavy cost pressure it over-acquires. This is the ranker's limit, not the stop rule's — the win holds on the synthetic regime with clean scores (`npm run train-stop -- --synthetic`). Swapping in embeddings would lift this the same way it fixes the confident misses above.
- **Labels are derived, not oracle.** `G_x` comes from an LLM judge + heuristic, not benchmark annotation. Human gold calibration is scaffolded (`--make-gold`) but pending.
- **Single-user, small n.** 126 tasks from one operator's history; the test split is ~25, so numbers are noisy. This proves the mechanism on real data; it's a design study, not a large-scale benchmark.

← [02 · The design](02-design.md)
