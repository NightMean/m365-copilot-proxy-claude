#!/usr/bin/env bash
# Offline END-TO-END validation: boots the REAL built Nitro server against the
# scripted FakeTransport backend (M365_FAKE_MODE=1) and drives it over HTTP:
#
#   1. /health, /v1/models, /v1/system-prompts discovery
#   2. a complete Anthropic agentic tool loop (tool_use -> local bash exec in a
#      sandbox dir -> tool_result -> final answer), exactly what Claude Code does
#   3. streaming SSE shape check
#   4. optional: a real `claude -p` headless run when RUN_CLAUDE_E2E=1 and
#      CLAUDE_BIN exists (full harness incl. MCP/skills config)
#
# No auth, no network to Microsoft, no quota. CI-safe.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORT:-4141}"
BASE="http://127.0.0.1:${PORT}"
OUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/m365-e2e.XXXXXX")"

echo "[e2e] building…"
cd "$ROOT"
corepack pnpm -r build >/dev/null

echo "[e2e] booting proxy in FAKE mode on :${PORT}"
M365_FAKE_MODE=1 PORT="$PORT" node packages/proxy/.output/server/index.mjs >"$OUT_DIR/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

for i in $(seq 1 40); do
  if curl -fsS -H "Authorization: Bearer m365" "$BASE/health" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

fail() { echo "[e2e] FAIL: $1" >&2; cat "$OUT_DIR/server.log" >&2; exit 1; }

# 1 — discovery ---------------------------------------------------------------
curl -fsS -H "Authorization: Bearer m365" "$BASE/health" | grep -q '"status":"ok"' || fail "health"
MODELS=$(curl -fsS -H "Authorization: Bearer m365" "$BASE/v1/models")
echo "$MODELS" | grep -q 'claude-sonnet' || fail "models missing claude-sonnet"
echo "$MODELS" | grep -q '"supportsTools":true' || fail "models missing capability metadata"
PROMPTS=$(curl -fsS -H "Authorization: Bearer m365" "$BASE/v1/system-prompts")
echo "[e2e] discovery ok ($(echo "$PROMPTS" | grep -o '"name"' | wc -l | tr -d ' ') prompts indexed)"

# 2 — agentic tool loop in a sandbox dir --------------------------------------
SBX="$OUT_DIR/sandbox"; mkdir -p "$SBX"; echo "hello-from-sandbox" > "$SBX/note.txt"

TOOL_TURN=$(curl -fsS -H "Authorization: Bearer m365" -H "Content-Type: application/json" -X POST "$BASE/v1/messages" -H 'Content-Type: application/json' -d '{
  "model":"claude-sonnet","max_tokens":1024,
  "tools":[{"name":"bash","description":"Run a shell command",
    "input_schema":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}],
  "messages":[{"role":"user","content":"read note.txt"}]
}')
echo "$TOOL_TURN" | grep -q '"stop_reason":"tool_use"' || fail "turn1 not tool_use: $TOOL_TURN"
CMD=$(echo "$TOOL_TURN" | sed -n 's/.*"command":"\([^"]*\)".*/\1/p')
[ -n "$CMD" ] || fail "no command extracted"

OUTPUT=$( (cd "$SBX" && eval "$CMD") 2>&1 ) || true

FINAL=$(curl -fsS -H "Authorization: Bearer m365" -H "Content-Type: application/json" -X POST "$BASE/v1/messages" -H 'Content-Type: application/json' -d "{
  \"model\":\"claude-sonnet\",\"max_tokens\":1024,
  \"tools\":[{\"name\":\"bash\",\"description\":\"Run a shell command\",
    \"input_schema\":{\"type\":\"object\",\"properties\":{\"command\":{\"type\":\"string\"}},\"required\":[\"command\"]}}],
  \"messages\":[
    {\"role\":\"user\",\"content\":\"read note.txt\"},
    {\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"call_e2e\",\"name\":\"bash\",\"input\":{\"command\":\"$CMD\"}}]},
    {\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"call_e2e\",\"content\":\"$(echo "$OUTPUT" | sed 's/"/\\"/g')\"}]}
  ]
}")
echo "$FINAL" | grep -q '"stop_reason":"end_turn"' || fail "turn2 not end_turn: $FINAL"
echo "[e2e] tool loop ok (cmd=\"$CMD\" -> \"$OUTPUT\")"

# 3 — streaming shape ----------------------------------------------------------
SSE=$(curl -fsS -H "Authorization: Bearer m365" -N -X POST "$BASE/v1/messages" -H 'Content-Type: application/json' -d '{
  "model":"gpt-5.5","max_tokens":64,"stream":true,
  "messages":[{"role":"user","content":"say hi"}]
}')
echo "$SSE" | grep -q '^event: message_start' || fail "no message_start"
echo "$SSE" | grep -q '^event: content_block_delta' || fail "no deltas"
echo "$SSE" | grep -q '^event: message_stop' || fail "no message_stop"
DELTA_COUNT=$(echo "$SSE" | grep -c '^event: content_block_delta' | tr -d ' ')
[ "$DELTA_COUNT" -gt 1 ] || fail "not incremental ($DELTA_COUNT deltas)"
echo "[e2e] streaming ok ($DELTA_COUNT deltas)"

# 4 — optional full-harness run -------------------------------------------------
if [[ "${RUN_CLAUDE_E2E:-0}" == "1" && -x "${CLAUDE_BIN:-$HOME/.local/bin/claude}" ]]; then
  echo "[e2e] running headless Claude Code against fake proxy…"
  (
    cd "$SBX"
    export ANTHROPIC_BASE_URL="$BASE" \
           ANTHROPIC_AUTH_TOKEN="local" \
           ANTHROPIC_MODEL="gpt-5.5" ANTHROPIC_SMALL_FAST_MODEL="gpt-5.5" \
           CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1
    unset ANTHROPIC_API_KEY
    "${CLAUDE_BIN:-$HOME/.local/bin/claude}" -p "Use the bash tool to run: cat note.txt — then reply with its exact contents." \
      --permission-mode acceptEdits >"$OUT_DIR/claude.log" 2>&1
  ) && grep -q "hello-from-sandbox" "$OUT_DIR/claude.log" && echo "[e2e] claude harness loop ok" || fail "claude harness (see $OUT_DIR/claude.log)"
else
  echo "[e2e] skipping live claude harness (set RUN_CLAUDE_E2E=1 + CLAUDE_BIN to enable)"
fi

echo "[e2e] ALL OK (artifacts in $OUT_DIR)"
