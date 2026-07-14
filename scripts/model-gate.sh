#!/usr/bin/env bash
# model-gate.sh — thin wrapper around the Node deliberation engine.
#   model-gate.sh decide  < task.json    -> decision JSON on stdout
#   model-gate.sh record  < result.json  -> update the local ledger
# Node stdlib only; no runtime deps. Override the interpreter with NODE_BIN.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${NODE_BIN:-node}" "$HERE/lib/model-gate.js" "$@"
