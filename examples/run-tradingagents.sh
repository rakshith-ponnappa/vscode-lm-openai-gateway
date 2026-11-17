#!/usr/bin/env bash
# Run TradingAgents (or any OpenAI-compatible CLI) against the local gateway. Extra args go to the CLI.
#
#   TA_DIR=/path/to/TradingAgents QUICK_MODEL=<model-id> DEEP_MODEL=<model-id> ./examples/run-tradingagents.sh
#
# TA_BIN defaults to the tradingagents entry point inside TA_DIR's virtualenv.
# List model ids: curl -s -H "Authorization: Bearer $(cat ~/.copilot-lm-gateway/token)" http://127.0.0.1:8787/v1/models
set -euo pipefail

: "${TA_DIR:?set TA_DIR to your TradingAgents checkout, e.g. TA_DIR=/path/to/TradingAgents}"
TA_BIN="${TA_BIN:-.venv/bin/tradingagents}"
source "$(dirname "$0")/ta-env.sh"

cd "$TA_DIR"
exec "$TA_BIN" "$@"
