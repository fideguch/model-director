# Deliberation — inputs, algorithm, ledger, records

The gate is implemented in `scripts/lib/model-gate.js` and configured by
`scripts/model-profiles.json`. This document is the human-readable spec.

## Gate inputs

| Input | Values | Collection |
|-------|--------|------------|
| Task role | `planning`, `review`, `execution` | Infer from the deliverable; split mixed work first |
| Complexity | `low`, `medium`, `high`, `frontier` | Explicit, or scored from signals |
| Signals | novel, architecture, irreversible, ambiguous, files, context_tokens, multi_system_debug, mechanical | Caller supplies booleans/counts |
| Model profile | capabilities, role eligibility, cost, scarcity | Static `model-profiles.json` |
| Quota | `remaining_ratio`, confidence | Observation if surfaced, else ledger estimate |
| Cost sensitivity | `low`, `normal`, `high` | Caller override; default `normal` |

### Complexity score

```
+2 novel/frontier reasoning
+2 architecture OR irreversible/high-risk decision
+1 ambiguous requirements
+1 >5 files/components
+1 context > 50k estimated tokens
+1 multi-system debugging
-1 mechanical or precisely specified
=> low <=0 ; medium 1–2 ; high 3–4 ; frontier >=5
```

## Quota — truth and fallback

Verified against Claude Code and Codex CLI 0.144.4: **no CLI reliably returns
remaining subscription allowance** per model today. Therefore quota is an
**estimate**:

1. If a call surfaces a rate-limit / reset / remaining value, store it as an
   **observation** (highest confidence, `high`).
2. Otherwise estimate from the **local rolling-window ledger** vs configurable
   **soft budgets** (confidence `low`).
3. Apply a **25% safety reserve**; unknown quota biases **conservative**
   (preserve Fable). Never inspect auth files.

### Ledger schema (`$MODEL_DIRECTOR_HOME/ledger.json`, default `~/.model-director/`)

```json
{
  "version": 1,
  "subscriptions": { "anthropic": { "windows": [ { "id":"rolling-5h",
    "duration_sec":18000, "soft_budget": { "fable":{"calls":12,"tokens":120000} } } ] } },
  "events": [ { "id":"...", "started_at":"RFC3339", "ended_at":"RFC3339",
    "provider":"openai", "model":"gpt-5.6-sol", "subtask_id":"plan-1",
    "status":"success", "input_tokens":1200, "output_tokens":500,
    "tokens_source":"cli|session|estimate", "rate_limited":false } ],
  "observations": [ { "at":"RFC3339", "provider":"openai", "model":"gpt-5.6-sol",
    "remaining_ratio":0.42, "resets_at":"RFC3339", "source":"cli-event|manual" } ]
}
```

Update points: `record` appends an event; if `remaining_ratio` is present it
also appends an observation; expired rows (older than 2 windows) are pruned;
writes are atomic (temp file + rename). Soft budgets are user-editable.

## Selection algorithm (deterministic)

```
level    = explicit complexity, else scoreComplexity(signals)
chain    = model-profiles.json.fallback_chains[role][level]
reserve  = policy.safety_reserve_ratio (0.25)
for m in chain:
  skip if role not in profile[m].roles
  skip if profile[m].min_complexity > level
  if m == fable: skip unless (level in {high,frontier}
                              AND availability.fable != false
                              AND remaining_ratio >= policy.fable_min_remaining_ratio)
  skip if availability[m] == false
  skip if quota unavailable (hard rate-limit)
  skip if remaining_ratio - reserve <= 0
  -> choose m
if none: cheapest still-available model in chain (last resort); else opus
```

Under `cost_sensitivity: high`, the chain is reordered by ascending cost before
selection. On rate-limit, record it and advance once through the chain — never
loop. `MODEL_DIRECTOR_FABLE=off` forces `availability.fable=false` globally.

## Deliberation record

Every `decide` appends one JSON line to `$MODEL_DIRECTOR_HOME/deliberations.jsonl`
with: `timestamp, task_id, subtask_id, role, signals, complexity,
cost_sensitivity, quota_snapshot, candidates, rejections, chosen, fallbacks,
dispatch, reason, ledger_confidence, summary`.

User-facing `summary` example:

> gpt-5.6-sol for planning (high), fallback: opus → sonnet. planning/high →
> gpt-5.6-sol; Fable preserved (fable-unavailable-this-session); quota
> confidence: low.
