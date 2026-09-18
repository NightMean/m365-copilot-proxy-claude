#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="${M365_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/m365-copilot-proxy}"
STATE_DIR="${M365_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/m365-copilot-proxy}"
USER_BIN_DIR="${M365_BIN_DIR:-$HOME/.local/bin}"
ENV_FILE="${M365_LOCAL_ENV:-$CONFIG_DIR/proxy.env}"
PID_FILE="$STATE_DIR/proxy.pid"
LOG_FILE="$STATE_DIR/proxy.log"
CONNECTION_FILE="$STATE_DIR/claude-connection.env"
BACKEND_FILE="$STATE_DIR/proxy.backend"
CLAUDE_WRAPPER="$USER_BIN_DIR/claude"
CLAUDE_DIRECT_WRAPPER="$USER_BIN_DIR/claude-direct"
CONTROL_BIN="$ROOT/bin/m365-copilot"
PROXY_PORT="${PORT:-4141}"
PROXY_URL="http://127.0.0.1:$PROXY_PORT"
SYSTEMD_UNIT_NAME="m365-copilot-proxy.service"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SYSTEMD_UNIT_FILE="$SYSTEMD_USER_DIR/$SYSTEMD_UNIT_NAME"

usage() {
  cat <<'EOF'
M365 Copilot Proxy manager (Linux)

Usage: m365-copilot <command> [options]

Setup:
  install             Install the private Node runtime, dependencies, and command
  login               Sign in in a visible Microsoft browser window
  login-device        Sign in with Microsoft's device-code flow
  doctor              Check installation, authentication, proxy, and Claude status

Proxy:
  start               Start the localhost proxy in the background
  stop                Stop the managed background proxy
  restart             Restart the managed proxy
  status              Show proxy and Claude connection status
  logs [--follow]     Show the proxy log
  models              List the proxy's M365 model catalog

Claude Code:
  connect-claude      Make the plain `claude` command use this proxy
  disconnect-claude   Restore the original Claude command
  claude [args...]    Internal connected-Claude launcher
  claude-direct [...] Internal original-Claude launcher

Removal:
  uninstall [--purge] Remove launchers; --purge also removes proxy config/logs

No command asks for or stores a Microsoft password or MFA seed.
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '%s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

ensure_private_dirs() {
  umask 077
  mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$USER_BIN_DIR"
  chmod 700 "$CONFIG_DIR" "$STATE_DIR"
}

ensure_runtime() {
  bash "$ROOT/scripts/setup-local.sh" >/dev/null
}

load_proxy_env() {
  [[ -f "$ENV_FILE" ]] || die "Proxy configuration is missing. Run: m365-copilot install"
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  PROXY_PORT="${PORT:-4141}"
  PROXY_URL="http://127.0.0.1:$PROXY_PORT"
}

proxy_health() {
  [[ -f "$ENV_FILE" ]] || return 1
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  local check_port="${PORT:-4141}"
  curl -fsS --max-time 3 \
    -H "Authorization: Bearer ${M365_PROXY_API_KEY:-}" \
    "http://127.0.0.1:${check_port}/v1/models" >/dev/null 2>&1
}

managed_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(tr -dc '0-9' < "$PID_FILE")"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

validate_managed_pid() {
  local pid="$1"
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" | grep -Fq 'm365-proxy.mjs'
}

systemd_user_available() {
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

unit_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '"%s"' "$value"
}

install_systemd_unit() {
  mkdir -p "$SYSTEMD_USER_DIR"
  local quoted_script quoted_port quoted_env
  quoted_script="$(unit_quote "$ROOT/scripts/run-proxy-local.sh")"
  quoted_port="$(unit_quote "PORT=$PROXY_PORT")"
  quoted_env="$(unit_quote "M365_LOCAL_ENV=$ENV_FILE")"
  {
    printf '%s\n' '[Unit]'
    printf '%s\n' 'Description=Local Microsoft 365 Copilot compatibility proxy'
    printf '%s\n' 'After=network-online.target'
    printf '%s\n' 'Wants=network-online.target'
    printf '\n%s\n' '[Service]'
    printf 'Environment=%s\n' "$quoted_port"
    printf 'Environment=%s\n' "$quoted_env"
    printf 'ExecStart=/usr/bin/env bash %s\n' "$quoted_script"
    printf '%s\n' 'Restart=on-failure'
    printf '%s\n' 'RestartSec=3'
    printf '%s\n' 'KillMode=control-group'
    printf 'StandardOutput=append:%s\n' "$LOG_FILE"
    printf 'StandardError=append:%s\n' "$LOG_FILE"
    printf '\n%s\n' '[Install]'
    printf '%s\n' 'WantedBy=default.target'
  } > "$SYSTEMD_UNIT_FILE"
  chmod 600 "$SYSTEMD_UNIT_FILE"
  systemctl --user daemon-reload
}

install_all() {
  [[ "$(uname -s)" == "Linux" ]] || die "The one-click launcher currently supports Linux only."
  require_command npm
  require_command curl
  ensure_private_dirs

  note "[1/4] Preparing the private Node.js runtime..."
  bash "$ROOT/scripts/setup-local.sh"
  note "[2/4] Installing locked dependencies..."
  bash "$ROOT/scripts/local.sh" install --frozen-lockfile
  note "[3/4] Building all packages..."
  bash "$ROOT/scripts/local.sh" build
  note "[4/4] Installing the m365-copilot command..."
  ln -sfn "$CONTROL_BIN" "$USER_BIN_DIR/m365-copilot"

  note ""
  note "Installation complete."
  note "Next: $USER_BIN_DIR/m365-copilot login"
  if [[ ":$PATH:" != *":$USER_BIN_DIR:"* ]]; then
    note "Add this directory to PATH before using the short command: $USER_BIN_DIR"
  fi
}

login_interactive() {
  ensure_runtime
  exec bash "$ROOT/scripts/local.sh" auth
}

login_device() {
  ensure_runtime
  exec bash "$ROOT/scripts/local.sh" auth:device
}

start_proxy() {
  require_command curl
  ensure_private_dirs
  ensure_runtime
  load_proxy_env

  if proxy_health; then
    note "Proxy is already answering at $PROXY_URL"
    return 0
  fi

  local old_pid
  if old_pid="$(managed_pid 2>/dev/null)"; then
    if validate_managed_pid "$old_pid"; then
      die "Proxy process $old_pid exists but is not healthy. Run: m365-copilot stop"
    fi
    rm -f "$PID_FILE"
  fi

  : > "$LOG_FILE"
  chmod 600 "$LOG_FILE"
  local new_pid
  if systemd_user_available; then
    install_systemd_unit
    systemctl --user reset-failed "$SYSTEMD_UNIT_NAME" 2>/dev/null || true
    systemctl --user start "$SYSTEMD_UNIT_NAME"
    printf '%s\n' systemd > "$BACKEND_FILE"
    new_pid="$(systemctl --user show "$SYSTEMD_UNIT_NAME" -p MainPID --value)"
  else
    setsid -f env PORT="$PROXY_PORT" M365_LOCAL_ENV="$ENV_FILE" \
      bash "$ROOT/scripts/run-proxy-local.sh" >>"$LOG_FILE" 2>&1 </dev/null
    new_pid=""
    for attempt in $(seq 1 20); do
      new_pid="$(pgrep -n -f "$ROOT/packages/proxy/bin/m365-proxy.mjs" || true)"
      [[ -n "$new_pid" ]] && break
      sleep 0.1
    done
    printf '%s\n' pid > "$BACKEND_FILE"
  fi
  [[ "$new_pid" =~ ^[0-9]+$ ]] && (( new_pid > 0 )) || die "Proxy service did not return a valid PID."
  printf '%s\n' "$new_pid" > "$PID_FILE"
  chmod 600 "$PID_FILE" "$BACKEND_FILE"

  local attempt
  for attempt in $(seq 1 60); do
    if proxy_health; then
      note "Proxy started in the background at $PROXY_URL (PID $new_pid)"
      note "Log: $LOG_FILE"
      return 0
    fi
    if ! kill -0 "$new_pid" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done

  if [[ "$(cat "$BACKEND_FILE" 2>/dev/null || true)" == "systemd" ]]; then
    systemctl --user stop "$SYSTEMD_UNIT_NAME" 2>/dev/null || true
  else
    kill -TERM "$new_pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE" "$BACKEND_FILE"
  note "Proxy failed to start. Last log lines:" >&2
  tail -n 30 "$LOG_FILE" >&2 || true
  return 1
}

stop_proxy() {
  local pid
  if [[ "$(cat "$BACKEND_FILE" 2>/dev/null || true)" == "systemd" ]] && systemd_user_available; then
    if systemctl --user is-active --quiet "$SYSTEMD_UNIT_NAME"; then
      systemctl --user stop "$SYSTEMD_UNIT_NAME"
      rm -f "$PID_FILE" "$BACKEND_FILE"
      note "Proxy stopped."
      return 0
    fi
    rm -f "$PID_FILE" "$BACKEND_FILE"
  fi
  if ! pid="$(managed_pid 2>/dev/null)"; then
    rm -f "$PID_FILE"
    if proxy_health; then
      printf '%s\n' "Error: A proxy is answering, but it was not started by this manager. Stop its terminal/process manually." >&2
      return 1
    fi
    note "Proxy is not running."
    return 0
  fi

  validate_managed_pid "$pid" || die "Refusing to stop PID $pid because it is not the managed proxy process."
  kill -TERM "$pid"
  local attempt
  for attempt in $(seq 1 50); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      note "Proxy stopped."
      return 0
    fi
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  note "Proxy stopped after a forced shutdown."
}

restart_proxy() {
  stop_proxy
  start_proxy
}

claude_is_connected() {
  [[ -f "$CLAUDE_WRAPPER" ]] && grep -q '^# M365_COPILOT_MANAGED_CLAUDE=1$' "$CLAUDE_WRAPPER"
}

status_all() {
  load_proxy_env
  local pid=""
  if [[ "$(cat "$BACKEND_FILE" 2>/dev/null || true)" == "systemd" ]] && systemd_user_available; then
    pid="$(systemctl --user show "$SYSTEMD_UNIT_NAME" -p MainPID --value 2>/dev/null || true)"
    [[ "$pid" == "0" ]] && pid=""
  else
    pid="$(managed_pid 2>/dev/null || true)"
  fi
  if proxy_health; then
    note "Proxy: running at $PROXY_URL${pid:+ (PID $pid)}"
  else
    note "Proxy: stopped or unhealthy at $PROXY_URL"
  fi
  if claude_is_connected; then
    note "Claude: connected to M365 through the managed wrapper"
  else
    note "Claude: normal/direct mode"
  fi
  note "Config: $ENV_FILE"
  note "Log: $LOG_FILE"
}

show_logs() {
  [[ -f "$LOG_FILE" ]] || die "No proxy log exists yet."
  if [[ "${1:-}" == "--follow" || "${1:-}" == "-f" ]]; then
    exec tail -f "$LOG_FILE"
  fi
  tail -n 100 "$LOG_FILE"
}

list_models() {
  require_command curl
  load_proxy_env
  proxy_health || die "Proxy is not running. Run: m365-copilot start"
  curl -fsS -H "Authorization: Bearer ${M365_PROXY_API_KEY}" "$PROXY_URL/v1/models" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const m of JSON.parse(s).data??[])console.log(`${m.id}${m.name?`\t${m.name}`:""}`)})'
}

write_claude_wrapper() {
  local destination="$1"
  local action="$2"
  printf '#!/usr/bin/env bash\n# M365_COPILOT_MANAGED_CLAUDE=1\nset -euo pipefail\nexec %q %q "$@"\n' \
    "$CONTROL_BIN" "$action" > "$destination"
  chmod 700 "$destination"
}

connect_claude() {
  ensure_private_dirs
  ensure_runtime

  if claude_is_connected && [[ -f "$CONNECTION_FILE" ]]; then
    note "Claude is already connected to the M365 proxy."
    return 0
  fi

  local original_claude=""
  local restore_mode="shadow"
  local backup_path="$STATE_DIR/claude.original"

  if [[ -x "$USER_BIN_DIR/claude-anthropic" ]] && [[ -f "$CLAUDE_WRAPPER" ]] \
    && grep -Fq 'scripts/claude-local.sh' "$CLAUDE_WRAPPER"; then
    original_claude="$USER_BIN_DIR/claude-anthropic"
    restore_mode="symlink"
    rm -f "$CLAUDE_WRAPPER"
  else
    original_claude="$(command -v claude 2>/dev/null || true)"
    [[ -n "$original_claude" ]] || die "Claude Code is not installed or is not on PATH. Install Claude Code first."
    if [[ "$original_claude" == "$CLAUDE_WRAPPER" ]]; then
      [[ ! -e "$backup_path" && ! -L "$backup_path" ]] || die "Claude backup already exists: $backup_path"
      mv "$CLAUDE_WRAPPER" "$backup_path"
      original_claude="$backup_path"
      restore_mode="moved"
    fi
  fi

  printf 'ORIGINAL_CLAUDE=%q\nRESTORE_MODE=%q\nBACKUP_PATH=%q\n' \
    "$original_claude" "$restore_mode" "$backup_path" > "$CONNECTION_FILE"
  chmod 600 "$CONNECTION_FILE"

  node "$ROOT/scripts/claude-settings.mjs" clean-legacy "$STATE_DIR" || {
    rm -f "$CONNECTION_FILE"
    die "Could not safely migrate legacy Claude proxy settings."
  }
  write_claude_wrapper "$CLAUDE_WRAPPER" claude
  write_claude_wrapper "$CLAUDE_DIRECT_WRAPPER" claude-direct

  note "Claude is connected. Start the proxy, then run: claude"
  note "Use claude-direct anytime to bypass the proxy."
}

load_claude_connection() {
  [[ -f "$CONNECTION_FILE" ]] || die "Claude is not connected by this manager. Run: m365-copilot connect-claude"
  # shellcheck disable=SC1090
  source "$CONNECTION_FILE"
  [[ -x "$ORIGINAL_CLAUDE" ]] || die "Original Claude executable is missing: $ORIGINAL_CLAUDE"
}

disconnect_claude() {
  if [[ ! -f "$CONNECTION_FILE" ]]; then
    if claude_is_connected; then
      die "Managed Claude wrapper exists but its restore metadata is missing: $CONNECTION_FILE"
    fi
    note "Claude is already in normal/direct mode."
    return 0
  fi

  # shellcheck disable=SC1090
  source "$CONNECTION_FILE"
  claude_is_connected && rm -f "$CLAUDE_WRAPPER"
  if [[ -f "$CLAUDE_DIRECT_WRAPPER" ]] && grep -q '^# M365_COPILOT_MANAGED_CLAUDE=1$' "$CLAUDE_DIRECT_WRAPPER"; then
    rm -f "$CLAUDE_DIRECT_WRAPPER"
  fi

  case "$RESTORE_MODE" in
    moved)
      [[ -e "$BACKUP_PATH" || -L "$BACKUP_PATH" ]] || die "Original Claude backup is missing: $BACKUP_PATH"
      mv "$BACKUP_PATH" "$CLAUDE_WRAPPER"
      ;;
    symlink)
      ln -s "$ORIGINAL_CLAUDE" "$CLAUDE_WRAPPER"
      ;;
    shadow)
      ;;
    *)
      die "Unknown Claude restore mode: $RESTORE_MODE"
      ;;
  esac
  rm -f "$CONNECTION_FILE"
  note "Claude is disconnected. The normal Anthropic Claude command is restored."
}

run_claude_proxy() {
  load_claude_connection
  load_proxy_env
  proxy_health || die "Proxy is not running. Run in another terminal: m365-copilot start"
  # Default model must stay on a NON-reasoning tone: think-deeper routes through
  # M365's DeepLeo pipeline, which meta-analyzes injected harness prompts instead
  # of obeying them (docs/prompt-engineering.md) - the top cause of "model did not
  # understand the input". Windows launcher (connect-claude.ps1) already defaults
  # to gpt-5.5; keep both platforms identical.
  local selected_model="${MODEL:-gpt-5.5}"

  export ANTHROPIC_BASE_URL="$PROXY_URL"
  export ANTHROPIC_AUTH_TOKEN="$M365_PROXY_API_KEY"
  export ANTHROPIC_MODEL="$selected_model"
  export ANTHROPIC_SMALL_FAST_MODEL="$selected_model"
  export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
  export DISABLE_TELEMETRY=1
  export DISABLE_ERROR_REPORTING=1
  export DISABLE_BUG_COMMAND=1
  unset ANTHROPIC_API_KEY CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX

  # Per-process conversation identity: each CLI process gets its own
  # x-m365-session-id so distinct processes/hosts never fuse into one shared
  # M365 thread through the proxy's content fingerprint.
  case "${ANTHROPIC_CUSTOM_HEADERS:-}" in
    *x-m365-session-id*) ;;
    *)
      _m365_sid="cc-$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "proc-$$-$(date +%s)")"
      export ANTHROPIC_CUSTOM_HEADERS="${ANTHROPIC_CUSTOM_HEADERS:+${ANTHROPIC_CUSTOM_HEADERS}
}x-m365-session-id: ${_m365_sid}"
      ;;
  esac

  printf '[claude-m365] proxy=%s model=%s\n' "$PROXY_URL" "$selected_model" >&2

  # No client-side --tools restriction by default: the full Claude Code harness
  # catalog is declared to the proxy, where M365_MAX_TOOLS / M365_ALLOWED_TOOLS
  # cap the advertised manifest and ToolSearch promotes deferred tools on
  # demand. Launcher-level filtering would make deferred discovery impossible
  # and diverge from the Windows launchers. Escape hatch: M365_CLAUDE_TOOLS.
  local tools_args=()
  if [[ -n "${M365_CLAUDE_TOOLS:-}" ]]; then
    tools_args=(--tools="$M365_CLAUDE_TOOLS")
  fi
  exec "$ORIGINAL_CLAUDE" --model "$selected_model" ${tools_args[@]+"${tools_args[@]}"} "$@"
}

run_claude_direct() {
  load_claude_connection
  unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_MODEL ANTHROPIC_SMALL_FAST_MODEL
  unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX
  exec "$ORIGINAL_CLAUDE" "$@"
}

doctor() {
  local failures=0
  note "M365 Copilot Proxy doctor"
  note "Root: $ROOT"

  local command_name
  for command_name in bash npm curl; do
    if command -v "$command_name" >/dev/null 2>&1; then
      note "[ok] $command_name: $(command -v "$command_name")"
    else
      note "[missing] $command_name"
      failures=$((failures + 1))
    fi
  done

  local runtime_dir="${M365_RUNTIME_DIR:-$ROOT/.runtime}"
  if [[ -x "$runtime_dir/node/node_modules/node/bin/node" ]]; then
    note "[ok] private Node runtime installed"
  else
    note "[missing] private Node runtime; run install"
    failures=$((failures + 1))
  fi
  if [[ -f "${XDG_CONFIG_HOME:-$HOME/.config}/opencode-m365/msal-cache.json" ]]; then
    note "[ok] Microsoft token cache exists"
  else
    note "[missing] Microsoft token cache; run login"
    failures=$((failures + 1))
  fi
  if proxy_health; then
    note "[ok] proxy is healthy"
  else
    note "[info] proxy is not running or is unhealthy"
  fi
  if claude_is_connected; then
    note "[ok] Claude is connected to the proxy"
  elif command -v claude >/dev/null 2>&1; then
    note "[info] Claude is installed in normal/direct mode"
  else
    note "[info] Claude Code is not installed"
  fi
  if [[ -n "${ANTHROPIC_AUTH_TOKEN:-}" && -n "${ANTHROPIC_API_KEY:-}" ]]; then
    note "[warning] both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY are set in this shell"
  fi

  if (( failures > 0 )); then
    note "Doctor found $failures required item(s) to fix."
    return 1
  fi
  note "Doctor found no blocking installation problems."
}

uninstall_all() {
  local purge="${1:-}"
  stop_proxy || true
  disconnect_claude || true
  if [[ -L "$USER_BIN_DIR/m365-copilot" ]] && [[ "$(readlink "$USER_BIN_DIR/m365-copilot")" == "$CONTROL_BIN" ]]; then
    rm -f "$USER_BIN_DIR/m365-copilot"
  fi
  if [[ -f "$SYSTEMD_UNIT_FILE" ]] && grep -Fq "$ROOT/scripts/run-proxy-local.sh" "$SYSTEMD_UNIT_FILE"; then
    systemctl --user disable --now "$SYSTEMD_UNIT_NAME" 2>/dev/null || true
    rm -f "$SYSTEMD_UNIT_FILE"
    systemctl --user daemon-reload 2>/dev/null || true
  fi
  if [[ "$purge" == "--purge" ]]; then
    [[ "$CONFIG_DIR" == */m365-copilot-proxy ]] || die "Refusing to purge unexpected config path: $CONFIG_DIR"
    [[ "$STATE_DIR" == */m365-copilot-proxy ]] || die "Refusing to purge unexpected state path: $STATE_DIR"
    rm -rf -- "$CONFIG_DIR" "$STATE_DIR"
    note "Removed proxy configuration and logs. Microsoft token cache was preserved."
  fi
  note "Launchers removed. The downloaded repository and its private runtime were preserved."
}

command_name="${1:-help}"
shift || true
case "$command_name" in
  help|-h|--help) usage ;;
  install) install_all "$@" ;;
  login) login_interactive "$@" ;;
  login-device) login_device "$@" ;;
  start) start_proxy "$@" ;;
  stop) stop_proxy "$@" ;;
  restart) restart_proxy "$@" ;;
  status) status_all "$@" ;;
  logs) show_logs "$@" ;;
  models) list_models "$@" ;;
  connect-claude) connect_claude "$@" ;;
  disconnect-claude) disconnect_claude "$@" ;;
  claude) run_claude_proxy "$@" ;;
  claude-direct) run_claude_direct "$@" ;;
  doctor) doctor "$@" ;;
  uninstall) uninstall_all "$@" ;;
  *) die "Unknown command: $command_name. Run: m365-copilot help" ;;
esac
