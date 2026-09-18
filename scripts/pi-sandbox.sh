#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${PI_TARGET:-$PWD}"

if [[ $# -gt 0 && -d "$1" ]]; then
  TARGET="$1"
  shift
fi

TARGET="$(realpath "$TARGET")"
PRIVATE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/m365-copilot-proxy"
PIHOME="${XDG_STATE_HOME:-$HOME/.local/state}/m365-copilot-proxy/pi-home"
RUNTIME="$ROOT/.runtime"

if ! command -v bwrap >/dev/null 2>&1; then
  printf 'bubblewrap (bwrap) is required for the filesystem sandbox.\n' >&2
  exit 1
fi

bash "$ROOT/scripts/setup-local.sh" >/dev/null
mkdir -p "$PIHOME/.pi/agent"
chmod 700 "$PIHOME" "$PIHOME/.pi" "$PIHOME/.pi/agent"

# The target repository and the isolated Pi state are the only writable host
# paths. The network namespace is shared solely so Pi can reach the proxy bound
# to 127.0.0.1; keep command approvals enabled because outbound network remains
# technically available to tools.
exec bwrap \
  --die-with-parent \
  --new-session \
  --unshare-all \
  --share-net \
  --ro-bind /usr /usr \
  --symlink usr/bin /bin \
  --symlink usr/lib /lib \
  --symlink usr/lib64 /lib64 \
  --ro-bind /etc /etc \
  --proc /proc \
  --dev /dev \
  --tmpfs /tmp \
  --dir /run \
  --dir /home \
  --dir /opt \
  --ro-bind "$ROOT" /opt/m365-proxy \
  --ro-bind "$RUNTIME" /opt/m365-proxy/.runtime \
  --ro-bind "$PRIVATE_DIR" /run/m365-private \
  --bind "$PIHOME" /home/agent \
  --bind "$TARGET" /workspace \
  --chdir /workspace \
  --clearenv \
  --setenv HOME /home/agent \
  --setenv M365_LOCAL_ENV /run/m365-private/proxy.env \
  --setenv M365_PI_HOME /home/agent \
  --setenv MODEL "${MODEL:-gpt-5.5-think-deeper}" \
  --setenv PORT "${PORT:-4141}" \
  --setenv PATH /opt/m365-proxy/.runtime/node/node_modules/node/bin:/opt/m365-proxy/node_modules/.bin:/usr/bin:/bin \
  --setenv TERM "${TERM:-xterm-256color}" \
  --setenv LANG "${LANG:-C.UTF-8}" \
  /opt/m365-proxy/scripts/pi-local.sh "$@"
