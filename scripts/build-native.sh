#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cmake -S "$ROOT/native/editor" -B "$ROOT/native/editor/build"
cmake --build "$ROOT/native/editor/build" -j"$(nproc)"
echo "Built: $ROOT/native/editor/build/libsm-editor.so"
