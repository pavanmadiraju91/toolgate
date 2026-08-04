# Toolgate

**Make an agent's "which tools do I load?" decision visible, explained, and overridable.**

Toolgate is a small layer between a coding agent and its pile of connected tools. Before the agent starts a task, it builds a short, reasoned shortlist of the tools actually worth loading, then shows you what it picked, what it skipped, and why, with one-gesture controls to overrule it.

> This started as a personal itch. I run about 20 tool servers in my daily agent setup. Every turn, the agent drags a few hundred tool definitions into context whether the task needs them or not. Tokens burn, responses slow down, and the range of things it might reach for keeps growing. I couldn't see that decision and I couldn't steer it. Toolgate is my attempt to treat it as a design problem, not just an engineering one.

---

## The pain

Connect a handful of tool servers to an agent (MCP, plugins, whatever) and three things quietly go wrong:

1. **Context bloat.** Every tool's schema rides along in the prompt on every turn. Twenty servers can mean a few hundred definitions competing with your actual task for the model's attention.
2. **It's invisible.** The agent never tells you which tools it's carrying, or why. You find out only when it does something you didn't expect, or misses something you did.
3. **You can't steer it.** There's no "always bring this one" or "never touch that" short of editing config files and restarting.

The usual fixes are blunt. Load everything and you get the bloat and the risk. Hand-curate static profiles and they're rigid, plus you maintain them forever.

## The job to be done

> **When** I hand an agent a task that might need external tools,
> **I want** to trust it's carrying the right small set, and to see and adjust that choice,
> **so I can** keep it fast, focused, and in bounds without babysitting or editing config.

Which breaks down into: see the shortlist and the reasoning before work starts, understand the tradeoff being made (usefulness against the room it takes), correct it in one gesture when I disagree, and know when the agent isn't sure so I can lean in right then.

## How Toolgate does it

Every tool has to earn its place through one legible tradeoff:

| Term | Meaning |
|------|---------|
| **fit** | how well the tool matches the task (0 to 1) |
| **footprint** | the room it takes in context: its schema size, bumped up for slow or sensitive tools |
| **worth** | `fit − (λ × normalized footprint)`. Is it pulling its weight? |

Toolgate ranks tools best-fit first and keeps boarding while each is still worth it. When the next one isn't, it draws the **gate line** and stops. Then it reports how confident it is in that line: if the last tool boarded and the first tool held are nearly tied, it says so and widens the set rather than faking certainty. None of it is a black box. The whole decision is a record you can read, and your **board** / **hold** always win.

### It learns from you

Board a tool it held, or hold one it boarded, and Toolgate remembers. Under the hood that's a LinUCB contextual bandit: one small linear model per tool over the words in the task, trained on your board (reward 1) and hold (reward 0) choices. I used a bandit rather than a hand-rolled heuristic because it's the standard answer for learning to shortlist from thumbs-up/thumbs-down feedback. It handles cold start, needs few examples, stays readable, and its uncertainty term feeds the same "unsure, so widen" behavior the UI already shows. Keep boarding a tool for a kind of task and it starts clearing the gate on its own, no manual pin. One command shows it:

```bash
npm run learn   # a held tool boards on its own after a lesson or two
```

---

## See it in 60 seconds

```bash
npm run demo                 # score the sample tasks -> panel/decisions.json
npm run panel                # serve http://127.0.0.1:7799 to explore them
```

Or ask about one task:

```bash
node src/demo.mjs "summarize the design-critique slack channel and post a recap"
node src/demo.mjs "turn this figma frame into a react component" --pin ds.getComponent
```

The panel is the heart of the project. Each task shows its tools ranked, fit against footprint as a balance (green earns its place, amber is what it costs), the gate line, what got held and why, a confidence meter, and live board/hold toggles that re-weigh the decision and teach the learner in front of you. It's deliberately light and restrained: Hanken Grotesk with IBM Plex Mono, a green/amber pair that means something, and none of the indigo-gradient, centered-hero defaults most AI-built UIs land on.

## What's here

```
src/ranker.mjs      the shortlist engine (fit x footprint -> worth -> gate line)
src/learner.mjs     LinUCB contextual bandit; learns from board/hold feedback
src/text.mjs        shared tokenizer so the ranker and learner agree on features
src/broker.mjs      an MCP server exposing just two tools: find_tools + run_tool
src/prefs.mjs       load/save the learned bandit state
src/demo.mjs        CLI: run tasks, write a decision record for the panel
src/learn.mjs       CLI: watch a held tool learn to board itself
panel/index.html    the legibility and control UI (zero build, served locally)
config/             a sample tool catalog and the policy (lambda, floors, weights)
docs/               the case study: 01-problem, 02-design, 03-eval
```

## Why a broker, briefly

Agent runners load their tool list once at startup and don't reliably refresh it mid-session, so you can't just swap tools in and out on the fly. Toolgate works around that. The agent registers only Toolgate (two small tools), calls `find_tools(task)` to get the shortlist, then `run_tool(...)` to use anything on it. The visible tool list stays constant while the real decision happens inside Toolgate, where it can be seen, logged, and overruled. More in [`docs/02-design.md`](docs/02-design.md).

## Honest limitations

The default fit score is plain lexical matching so the repo runs with zero setup. It misses synonyms ("design files" doesn't match a Figma tool), and that shows up in the eval. Swapping in real embeddings is a one-function change. Confidence measures how clean the gate cut was, not whether fit got the answer, so it can be confidently wrong. That's exactly why board/hold and the learner are first-class. See [`docs/03-eval.md`](docs/03-eval.md) for where it works, where it doesn't, and what I'd do next.

## Status

A working prototype and design study, not production infrastructure. I built it to think through a real human–agent interaction problem from end to end: from the pain, to the job, to a steerable, legible design.
