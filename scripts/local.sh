#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$ROOT/scripts/setup-local.sh"
export PATH="$ROOT/.runtime/node/node_modules/node/bin:$PATH"

exec "$ROOT/.runtime/node/node_modules/.bin/pnpm" "$@"
