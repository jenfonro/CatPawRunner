#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found in PATH" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found in PATH" >&2
  exit 1
fi

if [ ! -d "$ROOT_DIR/node_modules/esbuild" ]; then
  echo "[build] missing dependencies: node_modules/esbuild" >&2
  echo "[build] run 'npm ci' (or 'npm install') first, then re-run this script" >&2
  exit 1
fi

echo "[build] bundling dist/ (esbuild)..."
rm -rf "$ROOT_DIR/dist"
NODE_ENV=production node "$ROOT_DIR/esbuild.js"
NODE_ENV=production node "$ROOT_DIR/esbuild-config.js"

OUT_DIR="$ROOT_DIR/build"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

PKG_BIN="$ROOT_DIR/node_modules/.bin/pkg"
if [ ! -x "$PKG_BIN" ]; then
  echo "[build] missing pkg: node_modules/.bin/pkg" >&2
  echo "[build] run 'npm i -D pkg' (or 'npm ci') first, then re-run this script" >&2
  exit 1
fi

PLATFORM="$(node -p "process.platform")"
ARCH="$(node -p "process.arch")"

TARGET=""
case "${PLATFORM}-${ARCH}" in
  linux-x64) TARGET="node18-linux-x64" ;;
  linux-arm64) TARGET="node18-linux-arm64" ;;
  darwin-x64) TARGET="node18-macos-x64" ;;
  darwin-arm64) TARGET="node18-macos-arm64" ;;
  win32-x64) TARGET="node18-win-x64" ;;
  win32-arm64) TARGET="node18-win-arm64" ;;
  *)
    echo "[build] unsupported platform/arch: ${PLATFORM}-${ARCH}" >&2
    echo "[build] supported: linux-x64 linux-arm64 darwin-x64 darwin-arm64 win32-x64 win32-arm64" >&2
    exit 1
    ;;
esac

echo "[build] packaging single-file binary via pkg (${TARGET})..."
OUT_NAME="catpawrunner"
OUT_PATH="$OUT_DIR/$OUT_NAME"
rm -f "$OUT_PATH" "$OUT_PATH.exe"

# pkg will pick up `require('./dist/index.js')` from standalone.cjs as long as dist exists before packaging.
# Work around pkg-fetch progress-bar bugs in some terminals/TTYs.
CI=1 PKG_DISABLE_PROGRESS=1 "$PKG_BIN" "$ROOT_DIR/standalone.cjs" --targets "$TARGET" --output "$OUT_PATH" || \
CI=1 PKG_DISABLE_PROGRESS=1 "$PKG_BIN" "$ROOT_DIR/standalone.cjs" --no-progress --targets "$TARGET" --output "$OUT_PATH"

if [ -f "$OUT_PATH.exe" ] && [ ! -f "$OUT_PATH" ]; then
  mv -f "$OUT_PATH.exe" "$OUT_PATH"
fi
chmod +x "$OUT_PATH" || true
echo "[build] done: $OUT_PATH"
