#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$ROOT/scripts/setup-local.sh" >/dev/null
# shellcheck disable=SC1091
source "${M365_LOCAL_ENV:-${XDG_CONFIG_HOME:-$HOME/.config}/m365-copilot-proxy/proxy.env}"

PROXY_PORT="${PORT:-4141}"
PROXY_URL="http://127.0.0.1:${PROXY_PORT}"
# Non-reasoning tone by default: *-think-deeper routes through M365's DeepLeo
# pipeline, which meta-analyzes harness prompts instead of obeying them.
MODEL="${MODEL:-gpt-5.5}"
CLAUDE_BIN="${CLAUDE_BIN:-${HOME}/.local/bin/claude-anthropic}"

if ! curl -fsS -H "Authorization: Bearer ${M365_PROXY_API_KEY}" "$PROXY_URL/v1/models" >/dev/null; then
  printf '%s\n' "[claude-local] no authenticated proxy answering at $PROXY_URL" >&2
  printf '%s\n' "[claude-local] start it in another terminal with: bash '$ROOT/scripts/local.sh' proxy:local" >&2
  exit 1
fi

export ANTHROPIC_BASE_URL="$PROXY_URL"
export ANTHROPIC_AUTH_TOKEN="$M365_PROXY_API_KEY"
export ANTHROPIC_MODEL="$MODEL"
export ANTHROPIC_SMALL_FAST_MODEL="$MODEL"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export DISABLE_TELEMETRY=1
export DISABLE_ERROR_REPORTING=1
export DISABLE_BUG_COMMAND=1
unset ANTHROPIC_API_KEY CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX

printf '[claude-local] proxy=%s  model=%s  tools=Bash,Read,Edit,Write,Glob,Grep\n' "$PROXY_URL" "$MODEL" >&2
# Use the --option=value spelling because --tools accepts multiple values; without
# it, a positional prompt can be mistaken for another tool name.
exec "$CLAUDE_BIN" --model "$MODEL" --tools=Bash,Read,Edit,Write,Glob,Grep "$@"
