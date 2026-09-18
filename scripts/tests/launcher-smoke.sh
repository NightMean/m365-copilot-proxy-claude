#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ORIGINAL_PATH="$PATH"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

TEST_HOME="$TEST_ROOT/home"
USER_BIN="$TEST_HOME/.local/bin"
FAKE_BIN="$TEST_ROOT/fake-bin"
CONFIG_DIR="$TEST_HOME/.config/m365-copilot-proxy"
STATE_DIR="$TEST_HOME/.local/state/m365-copilot-proxy"
SETTINGS_FILE="$TEST_HOME/.claude/settings.json"
mkdir -p "$USER_BIN" "$FAKE_BIN" "$(dirname "$SETTINGS_FILE")"

# The private Node/pnpm runtime install needs ~100 MB — keep it off the repo
# drive so the suite stays independent of checkout-disk headroom.
export M365_RUNTIME_DIR="$TEST_ROOT/runtime"

printf '#!/usr/bin/env bash\nprintf "fake-claude:%%s\\n" "$*"\n' > "$FAKE_BIN/claude"
chmod 700 "$FAKE_BIN/claude"
printf '%s\n' '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:4141","ANTHROPIC_MODEL":"gpt-5.5-think-deeper","KEEP_ME":"yes"},"model":"opus[1m]","theme":"dark"}' > "$SETTINGS_FILE"

export HOME="$TEST_HOME"
export PATH="$USER_BIN:$FAKE_BIN:$ORIGINAL_PATH"
export M365_BIN_DIR="$USER_BIN"
export M365_CONFIG_DIR="$CONFIG_DIR"
export M365_STATE_DIR="$STATE_DIR"
export CLAUDE_SETTINGS_FILE="$SETTINGS_FILE"

bash "$ROOT/scripts/m365-control.sh" connect-claude >/dev/null
grep -q '^# M365_COPILOT_MANAGED_CLAUDE=1$' "$USER_BIN/claude"
grep -q '^# M365_COPILOT_MANAGED_CLAUDE=1$' "$USER_BIN/claude-direct"
[[ "$(jq -r '.env.KEEP_ME' "$SETTINGS_FILE")" == "yes" ]]
[[ "$(jq -r '.env.ANTHROPIC_BASE_URL // "removed"' "$SETTINGS_FILE")" == "removed" ]]
[[ "$(jq -r '.model' "$SETTINGS_FILE")" == "opus[1m]" ]]
[[ "$("$USER_BIN/claude-direct" --version)" == "fake-claude:--version" ]]
bash "$ROOT/scripts/m365-control.sh" disconnect-claude >/dev/null
[[ ! -e "$USER_BIN/claude" ]]
[[ ! -e "$USER_BIN/claude-direct" ]]

printf '#!/usr/bin/env bash\nprintf "original-user-claude\\n"\n' > "$USER_BIN/claude"
chmod 700 "$USER_BIN/claude"
original_hash="$(sha256sum "$USER_BIN/claude" | cut -d' ' -f1)"
bash "$ROOT/scripts/m365-control.sh" connect-claude >/dev/null
grep -q '^# M365_COPILOT_MANAGED_CLAUDE=1$' "$USER_BIN/claude"
bash "$ROOT/scripts/m365-control.sh" disconnect-claude >/dev/null
restored_hash="$(sha256sum "$USER_BIN/claude" | cut -d' ' -f1)"
[[ "$restored_hash" == "$original_hash" ]]
[[ "$("$USER_BIN/claude")" == "original-user-claude" ]]

bash -n "$ROOT"/*.sh "$ROOT/bin/m365-copilot" "$ROOT/scripts/m365-control.sh"
node --check "$ROOT/scripts/claude-settings.mjs"

# --- PR1 parity: safe defaults + per-process identity + no client tool filter ---
if grep -q "dangerously-skip-permissions" "$ROOT/scripts/m365-control.sh"; then
  echo "FAIL: m365-control.sh must not hardcode --dangerously-skip-permissions (explicit opt-in only)" >&2
  exit 1
fi
grep -q "x-m365-session-id" "$ROOT/scripts/m365-control.sh" || {
  echo "FAIL: managed launcher must inject x-m365-session-id" >&2
  exit 1
}
if grep -q -- "--tools=Bash" "$ROOT/scripts/m365-control.sh"; then
  echo "FAIL: launcher-level --tools filtering blocks deferred-tool discovery" >&2
  exit 1
fi
if grep -q '"--dangerously-skip-permissions"' "$ROOT/connect-claude.ps1" && ! grep -q 'Unsafe' "$ROOT/connect-claude.ps1"; then
  echo "FAIL: connect-claude.ps1 ships skip-permissions without an explicit opt-in switch" >&2
  exit 1
fi

printf '%s\n' "launcher smoke tests passed"
