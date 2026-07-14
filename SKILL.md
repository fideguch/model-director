---
name: model-director
description: >-
  Dual-model ("二刀流") orchestrator. Before EVERY task, run a mandatory Model
  Deliberation Gate that weighs each model's strengths, weaknesses, and
  remaining quota, then routes planning/review to Claude Fable (or gpt-5.6-sol
  when Fable is scarce) and execution to Opus/Sonnet + GPT/Codex — spreading
  load across Anthropic and OpenAI subscriptions and conserving scarce Fable.
  Triggers: "model-director", "二刀流", "モデルディレクター", "どのモデルで",
  "Fableを温存", "SOLで実装", "作業を分解して振り分け", dual-model, model routing,
  planner/executor split.
license: MIT
metadata:
  version: 0.1.1
  depends-on: "claude-to-codex (>=0.1.1); OpenAI Codex CLI (>=0.144.4, authed); Node.js"
---

# Model Director

Runs a **dual-model development workflow**. It decides *which model does what*,
based on each model's fit and remaining quota, to spread load across the
Anthropic side (Fable / Opus / Sonnet) and the OpenAI side
(gpt-5.6-sol / terra / luna, via Codex) — and to **conserve scarce Fable**.

`model-director` is **policy**. It delegates GPT execution to the
**claude-to-codex** skill (**transport**), calling
`~/.claude/skills/claude-to-codex/scripts/codex-run.sh -m <model>`. It never
re-implements that bridge. Claude-side models are reached via
`Agent(model:'fable'|'opus'|'sonnet')` or the main loop.

## Model Deliberation Gate — MANDATORY, on every task

Before assigning any work, run the gate. Do not skip it, even for "obvious" tasks.

1. **Decompose** the request into independently assignable subtasks.
2. For each subtask, classify **role** (`planning` | `review` | `execution`)
   and fill the **signals** (see schema below).
3. **Run the gate** — one call per subtask:
   ```bash
   printf '%s' "$TASK_JSON" | scripts/model-gate.sh decide
   ```
   → returns a decision JSON with `chosen`, `fallbacks`, `dispatch`, `reason`,
   `quota_snapshot`, `ledger_confidence`, and a 1–3 line `summary`.
4. **Show the `summary`** to the user (transparency: which models, why, quota note).
5. **Dispatch** exactly the `chosen` model via `dispatch.command_hint`; on
   failure or rate-limit, advance once through `fallbacks` (never blind-retry).
6. **Record** every attempt (success or failure):
   ```bash
   printf '%s' "$RESULT_JSON" | scripts/model-gate.sh record
   ```
7. **Never** select Fable for routine execution, summarization, lookup, or
   mechanical review. Fable is reserved for `high`/`frontier` planning and
   adjudication.

**task.json** (stdin to `decide`):
```json
{ "task_id":"...", "subtask_id":"...", "role":"planning|review|execution",
  "signals":{"novel":false,"architecture":false,"irreversible":false,
             "ambiguous":false,"files":0,"context_tokens":0,
             "multi_system_debug":false,"mechanical":false},
  "complexity":"low|medium|high|frontier",   // optional; else computed from signals
  "cost_sensitivity":"low|normal|high",       // optional
  "availability":{"fable":false} }            // optional per-model overrides
```
**result.json** (stdin to `record`): `{ "provider","model","status","input_tokens","output_tokens","tokens_source","rate_limited", "remaining_ratio"?, "resets_at"? }`

See `references/deliberation.md` for the algorithm, ledger, and record formats,
and `references/model-profiles.md` for capabilities and routing.

## Routing defaults (encoded in the gate)

| Work | Default | Quota-spread alternative |
|------|---------|--------------------------|
| command / plan / decompose / spar | **Fable** (→ `gpt-5.6-sol` when scarce) | `gpt-5.6-sol` |
| review | **cross-model** (a model different from the implementer) | `gpt-5.6-sol` / `codex exec review` |
| execution (small) · writing · practical | **Opus** (main loop) | **Sonnet** |
| execution (large / parallel / mechanical) | **Opus ∥ Codex** | `gpt-5.6-terra` / `gpt-5.6-luna` |
| verify / completion | Opus (fable-for-opus Iron Law) | fresh cross-model verifier |

## Fable ⇄ SOL switch

Fable is the default planner but scarce. To move the thinking layer onto
`gpt-5.6-sol` (e.g. when Fable is rate-limited or unavailable):

- Per call: pass `"availability":{"fable":false}` in the task JSON, **or**
- Session-wide: `export MODEL_DIRECTOR_FABLE=off` — the gate then substitutes
  `gpt-5.6-sol` for every Fable pick automatically.

## Continuous execution (goal command)

After the plan is frozen, drive to completion with Claude Code's **`/loop`**:
each cycle re-runs the gate per ready subtask, dispatches, verifies, and
records — until no subtasks remain. State lives in `.fable/` (fable-for-opus).

## Optional quality gates

If the environment has `forge_ace` / `gatekeeper` / `token-guard`, execution
output is passed through them; if absent, those steps are **skipped silently**
(model-director degrades gracefully and stays generally useful).

## Files

| Path | Purpose |
|------|---------|
| `SKILL.md` | this file — activation + the gate protocol |
| `references/deliberation.md` | gate inputs, complexity scoring, quota estimation, ledger + record schema, selection algorithm |
| `references/model-profiles.md` | per-model strengths/weaknesses/cost/scarcity + routing |
| `scripts/model-gate.sh` | wrapper: `decide` / `record` |
| `scripts/lib/model-gate.js` | dependency-free deliberation engine |
| `scripts/model-profiles.json` | editable weights, fallback chains, soft budgets |
| `tests/` | engine unit tests |

## Install

Cloned to `~/.claude/skills/model-director` by the user's `set_up.sh` (single
installer). Requires the `claude-to-codex` skill, the Codex CLI (`>=0.144.4`,
`codex login`), and Node.js.
