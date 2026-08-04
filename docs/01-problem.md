# 01 · The problem

## Where this came from

I run about twenty tool servers in my day-to-day agent setup: docs, chat, design, a browser, search, a few others. It's genuinely useful. It also created a mess I couldn't see.

Every turn the agent takes, the definitions for *all* of those tools get pushed into its context. Doesn't matter if the task is "rename a variable" or "plan a launch." That's just how every agent runner I use behaves: connect a server and its tools are always there.

## The three symptoms

**Context bloat.** Tool definitions aren't free. Each one is a block of JSON schema (names, descriptions, argument shapes) sitting in the prompt on every turn. Twenty servers is easily a few hundred definitions, competing with the actual task for the model's attention and costing tokens on every call.

**The decision is invisible.** The agent never tells you which tools it's carrying, or why. From where the human sits there's no situational awareness. You notice the tool set only when something goes wrong: the agent reaches for something odd, or misses something obvious.

**There's no steering wheel.** Say you want the agent to always have a specific tool on this project, or never touch a destructive one. Your only options are editing config files and restarting. That's not steering, that's recompiling.

## Why the obvious fixes fall short

Loading everything is simple, but it maximizes the bloat, the latency, and the range of things the agent can casually reach for. Hand-curated profiles (a fixed tool set per kind of work) are better, but they're rigid: the set doesn't adapt to the actual task, and now you're the one maintaining it as tools come and go.

Both treat "which tools?" as a static config question. It's really a per-task judgment, and one the human should be able to see and correct.

## Reframing it as a design problem

"Select fewer tools" is the engineering framing. The part I care about is the human–agent interaction:

- How does an autonomous agent keep its human oriented about what it's about to do?
- How do you show a tradeoff (useful vs. costly) that's normally hidden?
- How do you make correcting it a single gesture instead of a config edit?
- How does the agent admit when it isn't sure, so the human knows when to lean in?

The rest of this study follows from that. The mechanism, a fit-vs-footprint shortlist, exists to serve the interaction, not the reverse.

Next: [02 · The design →](02-design.md)
