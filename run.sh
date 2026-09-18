#!/usr/bin/env bash
# run.sh — install, build, and start the m365-copilot-proxy.
#
#   ./run.sh              # install+build+serve (auto: real M365 if credentials
#                         #   exist, otherwise scripted FAKE mode)
#   ./run.sh --fake       # force offline scripted backend (no quota, no auth)
#   ./run.sh --tui        # same setup, then launch the interactive TUI
#   ./run.sh --dev        # hot-reload Nitro dev server instead of built output
#   ./run.sh --fresh      # force reinstall + rebuild even if up to date
#
# Env: PORT (default 4141), CLAUDE_BIN, M365_PROXY_API_KEY, M365_SYSTEM_PROMPT.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

PORT="${PORT:-4141}"
MODE="auto"
RUN_TUI=0
USE_DEV=0
FRESH=0

for arg in "$@"; do
  case "$arg" in
    --fake)  MODE="fake" ;;
    --tui)   RUN_TUI=1 ;;
    --dev)   USE_DEV=1 ;;
    --fresh) FRESH=1 ;;
    *) echo "unknown flag: $arg (see $0 --help)" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[36m[run]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[run]\033[0m %s\n' "$*"; }

# --- pnpm via corepack (no global install needed) ---------------------------
if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
else
  PNPM=(corepack pnpm)
  log "using corepack pnpm ($(corepack pnpm --version 2>/dev/null || echo '?'))"
fi

# --- install -----------------------------------------------------------------
if [[ $FRESH == 1 || ! -d node_modules ]]; then
  log "installing dependencies…"
  "${PNPM[@]}" install
else
  log "dependencies present (use --fresh to reinstall)"
fi

# --- build -------------------------------------------------------------------
if [[ $FRESH == 1 || ! -f packages/proxy/.output/server/index.mjs ]]; then
  log "building all packages…"
  "${PNPM[@]}" -r build
else
  log "build output present (use --fresh to rebuild)"
fi

# --- mode selection ------------------------------------------------------------
SECRETS="${XDG_CONFIG_HOME:-$HOME/.config}/opencode-m365/secrets.json"
if [[ $MODE == "auto" ]]; then
  if [[ -f "$SECRETS" ]]; then
    MODE="live"
  else
    MODE="fake"
    warn "no credentials at $SECRETS — starting in OFFLINE FAKE MODE."
    warn "scripted backend: everything works end-to-end except it is not a real model."
    warn "add secrets.json (README §Authentication) then re-run for live M365."
  fi
fi

export PORT
COMMON_ENV=()
if [[ $MODE == "fake" ]]; then
  export M365_FAKE_MODE=1
  log "starting proxy in FAKE mode on http://127.0.0.1:${PORT}"
elif [[ $MODE == "live" ]]; then
  log "starting proxy against live M365 on http://127.0.0.1:${PORT}"
fi

# --- run ------------------------------------------------------------------------
if [[ $RUN_TUI == 1 ]]; then
  log "launching TUI (proxy must be running in another terminal: ./run.sh)"
  exec node bin/m365-tui.mjs
fi

if [[ ! -f "$SECRETS" && $MODE == "live" ]]; then
  warn "credentials vanished before boot? falling back to fake mode."; export M365_FAKE_MODE=1
fi

if [[ $USE_DEV == 1 ]]; then
  exec "${PNPM[@]}" --filter @m365-copilot/proxy dev
else
  log "ready: ${PORT}/health · /v1/models · /v1/messages · /v1/system-prompts (API key: \${M365_PROXY_API_KEY:-m365})"
  exec node packages/proxy/.output/server/index.mjs
fi
