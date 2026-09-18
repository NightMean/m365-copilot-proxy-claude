#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$ROOT/scripts/setup-local.sh" >/dev/null
# shellcheck disable=SC1091
source "${M365_LOCAL_ENV:-${XDG_CONFIG_HOME:-$HOME/.config}/m365-copilot-proxy/proxy.env}"
export PATH="$ROOT/.runtime/node/node_modules/node/bin:$PATH"

exec node "$ROOT/packages/proxy/bin/m365-proxy.mjs" "${PORT:-4141}"
