# Changelog

## 0.1.1 — 2026-07-14

Fixes from an initial `gpt-5.6-sol` cross-model review of the engine:

- **Stale-observation overestimate**: quota observations are now discounted by
  usage recorded *since* the observation, instead of being returned unchanged
  until the window expires.
- **Last-resort eligibility**: last-resort selection only draws from candidates
  that passed every check except the safety reserve — it can no longer
  resurrect a role-ineligible or explicitly-unavailable model (e.g. Fable).
- **Concurrent `record`**: the read-modify-write now runs under an advisory
  lockfile so parallel executors don't lose events.
- `decide` output now exposes the `last_resort` flag.

## 0.1.0 — 2026-07-14

Initial release — dual-model ("二刀流") orchestrator.

- **Model Deliberation Gate** (`scripts/lib/model-gate.js`, dependency-free Node):
  complexity scoring from signals, ledger-based quota estimation with soft
  budgets and a 25% safety reserve, deterministic `role × complexity` routing,
  and JSONL deliberation records.
- **Fable ⇄ gpt-5.6-sol switch** via the task's `availability.fable` or the
  `MODEL_DIRECTOR_FABLE=off` environment variable.
- **Delegation model**: depends on `claude-to-codex` as the GPT transport bridge
  (`codex-run.sh`); never re-implements it. Claude-side models via
  `Agent(model:…)`.
- Configurable `scripts/model-profiles.json` (weights, fallback chains, soft
  budgets). References: `deliberation.md`, `model-profiles.md`.
- CI: shellcheck + `node --test`.
