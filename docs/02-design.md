# 02 · The design

Toolgate has two halves. There's the decision (which tools are worth loading) and the interface (how that decision gets shown and steered). The decision exists to be legible. The interface is where the real design work happens.

## Design principles

1. **Show the tradeoff, don't hide it.** Why a tool is in or out should be a number you can see, not a vibe.
2. **The human's word is final.** Any automatic choice has to be overridable in one gesture, and the override has to obviously win.
3. **Admit uncertainty.** When the cut is a close call, say so and widen. Never dress up a shaky decision as a confident one.
4. **Legible by construction.** No bolted-on "explanations." The thing that makes the decision is the same thing you see.

## The decision, in plain terms

Each tool earns its place through one tradeoff:

- **fit** is how well it matches the task (0 to 1).
- **footprint** is the room it takes in context: its schema token count, bumped up a little for slow tools and sensitive ones (writes, secrets).
- **worth** is `fit − (λ × normalized footprint)`. Positive means it's pulling its weight.

Rank tools best-fit first, keep **boarding** while each is still worth it, and stop at the **gate line**, the first tool that isn't. Two guardrails frame it: always board a minimum so a task never starves, and never exceed a maximum or a token budget. There's also a relevance floor, `fitFloor`: a tool needs real fit to board on its own. Without it, cheap tools sneak in just because they're small, and that's the failure mode that makes an auto-shortlist look uninformed.

So there are two dials with real meaning: `λ` (how hard footprint counts) and `fitFloor` (how relevant a tool has to be). Both are policy, not constants. [03 · Eval](03-eval.md) covers grounding them in real logs.

### Designing for the agent's uncertainty

This is the part I care about most. After finding the gate line, Toolgate measures the gap in worth between the last tool it boarded and the first it held. A wide gap means the line is obvious. A narrow gap means the boundary is basically a coin flip, and the interface says so: the confidence meter drops and the card notes it's holding a wider set. Designing for when the system *isn't* sure, not just for its answer, is what keeps the human in the loop at the right moments.

### Learning from what you do

Board and hold aren't only one-off overrides. They're training signal. Each choice feeds a LinUCB contextual bandit: one small linear model per tool over the words in the task, updated with board as reward 1 and hold as reward 0. I picked a bandit instead of writing my own heuristic because it's the standard answer for learning to shortlist from thumbs-up/thumbs-down feedback. It copes with cold start, needs few examples, stays readable, and its uncertainty term is the same signal that drives the "unsure, so widen" behavior above. The learned payoff gets added to `worth` and can lift a tool over the relevance floor, so a tool you keep boarding for a kind of task eventually clears the gate without being asked. It never takes the human out of the loop. It just stops making you repeat yourself.

## The interface

Per task, the panel answers three questions at a glance.

**What did it board?** A ranked list, each tool with a balance: amber footprint pulling left, green fit pulling right, so the tradeoff reads instantly.

**What did it hold, and why?** Held tools stay visible but dimmed below the gate line, each tagged with a reason (`weak fit`, `low worth`, `budget`, `gate full`, `held by you`).

**Can I disagree?** Board forces a tool in, hold forces it out. Toggling either re-weighs the whole manifest live (you watch the gate line and the "context saved" number move) and teaches the learner. Overriding is a conversation, not a form.

Each card carries a confidence meter, and when it's low the card says it's holding a wider set. The look is deliberately light and restrained, closer to Linear or Stripe than to the warm-cream, indigo-gradient template most AI tools land on.

## The broker (why the interface can exist at all)

To work inside real agent runners, Toolgate ships as a broker: an MCP server that exposes only two tools, `find_tools(task)` and `run_tool(server, tool, args)`.

Why not just add and remove tools on the fly? Because the runners I target read their tool list once at session start and don't reliably refresh it mid-session. Rather than fight that, Toolgate keeps the agent's visible tool list constant (two tools) and moves the real choice inside the broker:

1. The agent calls `find_tools(task)` and gets the shortlist plus reasons.
2. It calls `run_tool(...)` for anything on the list, and the broker proxies to the real server.

Constant surface for the runner, full control and logging for me, and a natural home for the legibility layer. Every `find_tools` call emits the same decision record the panel renders, so what the human reviews is exactly what the agent acted on.

## What I deliberately left out

No dynamic tool-list hot-swapping. Fighting the runners' startup-load model would be fragile, and the broker is the sturdier path. No model fine-tuning, because the whole thing is meant to be a light layer in front of existing tools. And no three-runner matrix. It's wired to one runner conceptually and portable over MCP, but I didn't spread a prototype thin proving the same point three times.

Next: [03 · Evaluation →](03-eval.md)
