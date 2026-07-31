#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE_DIR="${KOYAEDIT_NATIVE:-$ROOT/native/editor/build}"
APP_DIR="$ROOT/app"
PACKS_DIR="$ROOT/packs"

resolve_koya_bin() {
  if [[ -n "${KOYA_BIN:-}" ]]; then
    printf '%s\n' "$KOYA_BIN"
    return
  fi
  local candidates=(
    "$(command -v koya 2>/dev/null || true)"
    /usr/bin/koya
    /usr/local/bin/koya
  )
  local c
  for c in "${candidates[@]}"; do
    if [[ -n "$c" && -x "$c" ]]; then
      printf '%s\n' "$c"
      return
    fi
  done
  printf '%s\n' "koya"
}

KOYA_BIN="$(resolve_koya_bin)"

if [[ ! -x "$KOYA_BIN" ]]; then
  echo "koya binary not found: $KOYA_BIN" >&2
  echo "Install Koya from https://developer.koya-ui.com/install/ (or set KOYA_BIN)." >&2
  exit 1
fi

if [[ ! -f "$NATIVE_DIR/libsm-editor.so" ]]; then
  echo "Module/editor not built. Run:" >&2
  echo "  cmake -S \"$ROOT/native/editor\" -B \"$ROOT/native/editor/build\" && cmake --build \"$ROOT/native/editor/build\" -j" >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <workspace-path>" >&2
  echo "Example: $0 \"$ROOT\"" >&2
  exit 1
fi

WORKSPACE="$(cd "$1" && pwd)"
shift || true

MOUNT_ARGS=(-m "$APP_DIR")
if [[ -d "$PACKS_DIR" ]]; then
  MOUNT_ARGS+=(-m "$PACKS_DIR")
fi

echo "Using koya: $KOYA_BIN" >&2

exec "$KOYA_BIN" \
  --no-default-mounts \
  "${MOUNT_ARGS[@]}" \
  -n "$NATIVE_DIR" \
  -i index.js \
  "$WORKSPACE" "$@"
