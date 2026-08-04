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

← [02 · The design](02-design.md)
