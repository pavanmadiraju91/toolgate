# Eval

The tasks in `tasks.jsonl` are the ones discussed in [`../docs/03-eval.md`](../docs/03-eval.md).
They're chosen to span the range: a clear single-domain task, a real multi-tool
task, a research task, an intentionally vague one, and a cross-domain one.

Reproduce the run (writes `../panel/decisions.json`, which the panel renders):

```bash
node ../src/demo.mjs --all
```

Or score any one task:

```bash
node ../src/demo.mjs "your task here"
node ../src/demo.mjs "your task here" --pin some.tool --exclude other.tool
```

See `docs/03-eval.md` for the results table, the two honest failure cases, and
how to tune `λ` from your own session logs.
