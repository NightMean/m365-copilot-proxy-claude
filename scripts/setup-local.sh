#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Private runtime location. Override with M365_RUNTIME_DIR when the repo drive
# is short on space (the node+pnpm install needs ~100 MB) or to share one
# runtime across several checkouts.
RUNTIME="${M365_RUNTIME_DIR:-$ROOT/.runtime}"
PRIVATE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/m365-copilot-proxy"
ENV_FILE="${M365_LOCAL_ENV:-$PRIVATE_DIR/proxy.env}"
NODE_PREFIX="$RUNTIME/node"
NODE_VERSION="${M365_NODE_VERSION:-24.18.1}"
PNPM_VERSION="${M365_PNPM_VERSION:-10.32.1}"

umask 077
mkdir -p "$RUNTIME"
mkdir -p "$(dirname "$ENV_FILE")"
chmod 700 "$(dirname "$ENV_FILE")"

if [[ ! -f "$ENV_FILE" ]]; then
  API_KEY="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf 'export M365_PROXY_API_KEY=%q\nexport M365_REQUIRE_API_KEY=1\nexport M365_INTERACTIVE_LOGIN=1\nexport HOST=127.0.0.1\nexport NITRO_HOST=127.0.0.1\n' "$API_KEY" > "$ENV_FILE"
fi

if ! grep -q '^export M365_REQUIRE_API_KEY=' "$ENV_FILE"; then
  printf 'export M365_REQUIRE_API_KEY=1\n' >> "$ENV_FILE"
fi

chmod 600 "$ENV_FILE"

if [[ ! -x "$NODE_PREFIX/node_modules/node/bin/node" || ! -x "$NODE_PREFIX/node_modules/.bin/pnpm" ]]; then
  printf 'Installing private Node.js %s and pnpm %s runtime (one time)...\n' "$NODE_VERSION" "$PNPM_VERSION"
  npm install --prefix "$NODE_PREFIX" --no-save "node@$NODE_VERSION" "pnpm@$PNPM_VERSION"
fi

printf 'Local runtime configuration is ready at %s (mode 0600).\n' "$ENV_FILE"
