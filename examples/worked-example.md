# Worked example — one task through the gate

Goal: *"Add pagination to the users API and write tests."*

## 1. Decompose into assignable subtasks

| id | subtask | role |
|----|---------|------|
| s1 | design the pagination approach | planning |
| s2 | implement the endpoint | execution |
| s3 | write tests | execution |
| s4 | review the diff | review |

## 2–6. Per subtask: decide → show summary → dispatch → record

### s1 — planning (architecture + ambiguous → high)

```bash
printf '%s' '{"task_id":"pag","subtask_id":"s1","role":"planning","signals":{"architecture":true,"ambiguous":true}}' \
  | scripts/model-gate.sh decide
# chosen: "fable"  (or "gpt-5.6-sol" when MODEL_DIRECTOR_FABLE=off / Fable scarce)
```

Show the `summary` to the user. Dispatch the `chosen`:
- `fable` → `Agent(model:'fable')`
- `gpt-5.6-sol` → `claude-to-codex/scripts/codex-run.sh -m gpt-5.6-sol`

Then record the attempt:
```bash
printf '%s' '{"provider":"openai","model":"gpt-5.6-sol","subtask_id":"s1","status":"success","input_tokens":1800,"output_tokens":700}' \
  | scripts/model-gate.sh record
```

### s2 — execution, medium → `sonnet`
Dispatch `Agent(model:'sonnet')`; record.

### s3 — execution, low/mechanical → `gpt-5.6-luna`
```bash
printf '%s' '{"role":"execution","subtask_id":"s3","signals":{"mechanical":true}}' | scripts/model-gate.sh decide
# chosen: "gpt-5.6-luna"
```
Dispatch `codex-run.sh -m gpt-5.6-luna --write`; record.

### s4 — review, high → `gpt-5.6-sol` (cross-model: a model different from the implementer)
Dispatch `codex-run.sh -m gpt-5.6-sol` (or `codex exec review`); record.

## Continuous execution

Freeze the plan, then drive with Claude Code's **`/loop`**: each cycle re-runs
the gate for the next ready subtask, dispatches, verifies, and records — until
all subtasks are complete. Durable state lives in `.fable/` (fable-for-opus).

## Result

The four subtasks ran across **four different models** (Fable/SOL for thinking,
Sonnet + luna for execution, SOL for cross-model review), spreading load across
the Anthropic and OpenAI subscriptions while never spending Fable on mechanical
work.
