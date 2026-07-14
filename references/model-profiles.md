# Model profiles

These are **configurable routing assumptions**, not provider-published
capability or quota claims. The machine-readable source of truth is
`scripts/model-profiles.json`; edit that to retune routing. This table is the
human summary.

| Model | Provider / via | Strengths | Weaknesses | Cost | Scarcity | Best fit |
|-------|----------------|-----------|------------|:----:|:--------:|----------|
| `fable` | Anthropic / Claude Code | Deep planning, synthesis, adjudication | Scarce; wasteful on execution | 5 | 5 | Frontier plans, disputed reviews |
| `opus` | Anthropic / Claude Code | Autonomous complex execution, long-form | Expensive | 4 | 4 | Risky multi-file implementation |
| `sonnet` | Anthropic / Claude Code | Fast balanced coding | Weaker on frontier design | 2 | 1 | Routine implementation |
| `gpt-5.6-sol` | OpenAI / Codex | Strong reasoning & review | Costly, slower | 4 | 3 | Fable substitute, architecture |
| `gpt-5.6-terra` | OpenAI / Codex | Balanced coding & analysis | Less deep than sol | 3 | 1 | Medium/high execution, review |
| `gpt-5.6-luna` | OpenAI / Codex | Fast mechanical work | Weakest complex reasoning | 1 | 1 | Edits, tests, summaries |

`cost` and `scarcity` are 1–5 relative weights (higher = more expensive /
scarcer). The gate prefers cheaper, less-scarce models when capability allows,
and reserves Fable for `high`/`frontier` planning and adjudication.

## Dispatch

- **Anthropic models** (`via: claude-code`): `Agent(model:'fable'|'opus'|'sonnet')`,
  or the main loop for `opus`.
- **OpenAI models** (`via: codex`): the claude-to-codex bridge —
  `claude-to-codex/scripts/codex-run.sh -m <model> [--write]`. Read-only for
  review; `--write` for delegated execution.

## Fallback chains

Defined per `role` × `complexity` in `model-profiles.json`. Summary:

- **planning** high/frontier: `fable → gpt-5.6-sol → opus`; medium/low: `gpt-5.6-sol → opus → sonnet`
- **review** high/frontier: `gpt-5.6-sol → fable → opus`; medium/low: `gpt-5.6-terra → sonnet → gpt-5.6-luna`
- **execution** high/frontier: `opus → gpt-5.6-terra → gpt-5.6-sol`; medium: `sonnet → gpt-5.6-terra → opus`; low: `gpt-5.6-luna → sonnet → gpt-5.6-terra`
