#!/usr/bin/env bash
# Source this file (". examples/ta-env.sh") to point an OpenAI-compatible client - here TradingAgents -
# at the local gateway. Nothing in this file is secret: the API key is read from the gateway's token file.
#
# Required:
#   QUICK_MODEL / DEEP_MODEL   model ids as listed by GET /v1/models (e.g. QUICK_MODEL=<model-id>)
# Optional:
#   GATEWAY_PORT               defaults to 8787 (must match the copilotGateway.port setting)
#   GATEWAY_TOKEN_FILE         defaults to ~/.copilot-lm-gateway/token
#   FRED_API_KEY, SEC_EDGAR_USER_AGENT
#                              export them yourself, or set FRED_KEYCHAIN_SERVICE / SEC_UA_KEYCHAIN_SERVICE
#                              to the service name of a macOS Keychain generic-password item to read them from.
#
# The TRADINGAGENTS_* variable names below match the TradingAgents build this was written against;
# check your version's configuration and adjust if they differ.

TOKEN_FILE="${GATEWAY_TOKEN_FILE:-$HOME/.copilot-lm-gateway/token}"
[[ -r "$TOKEN_FILE" ]] || { echo "No gateway token at $TOKEN_FILE. Is the extension installed and VS Code open?" >&2; return 1; }
[[ -n "${QUICK_MODEL:-}" && -n "${DEEP_MODEL:-}" ]] || {
  echo "Set QUICK_MODEL and DEEP_MODEL to model ids from: curl -s -H \"Authorization: Bearer \$(cat $TOKEN_FILE)\" http://127.0.0.1:${GATEWAY_PORT:-8787}/v1/models" >&2
  return 1
}

# "openai" (not "openai_compatible") so structured output forces tool_choice; a custom base_url keeps it on Chat Completions.
export TRADINGAGENTS_LLM_PROVIDER=openai
export TRADINGAGENTS_LLM_BACKEND_URL="http://127.0.0.1:${GATEWAY_PORT:-8787}/v1"
export OPENAI_API_KEY="$(<"$TOKEN_FILE")"
# Reasoning effort is set by the gateway (copilotGateway.reasoningEffort setting).
export TRADINGAGENTS_QUICK_THINK_LLM="$QUICK_MODEL"
export TRADINGAGENTS_DEEP_THINK_LLM="$DEEP_MODEL"
export TRADINGAGENTS_MAX_DEBATE_ROUNDS="${TRADINGAGENTS_MAX_DEBATE_ROUNDS:-1}"
export TRADINGAGENTS_MAX_RISK_ROUNDS="${TRADINGAGENTS_MAX_RISK_ROUNDS:-1}"
export TRADINGAGENTS_OUTPUT_LANGUAGE="${TRADINGAGENTS_OUTPUT_LANGUAGE:-English}"
export TRADINGAGENTS_NO_UPDATE_CHECK=1

_from_keychain() {
  [[ -n "$1" ]] && command -v security >/dev/null 2>&1 && security find-generic-password -s "$1" -w 2>/dev/null || true
}
if [[ -z "${FRED_API_KEY:-}" ]]; then
  FRED_API_KEY="$(_from_keychain "${FRED_KEYCHAIN_SERVICE:-}")"; [[ -n "$FRED_API_KEY" ]] && export FRED_API_KEY
fi
if [[ -z "${SEC_EDGAR_USER_AGENT:-}" ]]; then
  SEC_EDGAR_USER_AGENT="$(_from_keychain "${SEC_UA_KEYCHAIN_SERVICE:-}")"; [[ -n "$SEC_EDGAR_USER_AGENT" ]] && export SEC_EDGAR_USER_AGENT
fi
unset -f _from_keychain
return 0
