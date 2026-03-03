#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash build_releases.sh v1.0.0

Env:
  USE_DOCKER   1=use docker (default), 0=use local node/npm
  OUT_DIR      Output root (default: ./build)
  NODE_IMAGE   Docker node image (default: node:20-bookworm)
  HTTP_PROXY   Optional proxy
  HTTPS_PROXY  Optional proxy
  ALL_PROXY    Optional proxy
  NO_PROXY     Optional no_proxy
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

VERSION="$(echo "$1" | tr -d '[:space:]')"
if [[ -z "${VERSION}" ]]; then
  echo "version is required" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CALLER_DIR="$(pwd)"
USE_DOCKER="${USE_DOCKER:-1}"
OUT_ROOT="${OUT_DIR:-${CALLER_DIR}/build}"
OUT_VERSION_DIR="${OUT_ROOT}/${VERSION}"
NODE_IMAGE="${NODE_IMAGE:-node:20-bookworm}"
HTTP_PROXY="${HTTP_PROXY:-}"
HTTPS_PROXY="${HTTPS_PROXY:-${HTTP_PROXY}}"
ALL_PROXY="${ALL_PROXY:-}"
NO_PROXY="${NO_PROXY:-}"

UNAME_S="$(uname -s 2>/dev/null || true)"
IS_MSYS=0
if [[ "${UNAME_S}" == MINGW* || "${UNAME_S}" == MSYS* || "${UNAME_S}" == CYGWIN* ]]; then
  IS_MSYS=1
fi

HOST_PROJECT_DIR="${SCRIPT_DIR}"
if [[ "${IS_MSYS}" == "1" ]]; then
  HOST_PROJECT_DIR="$(cd "${SCRIPT_DIR}" && pwd -W | tr '\\' '/')"
fi

docker_cmd() {
  if [[ "${IS_MSYS}" == "1" ]]; then
    MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' docker "$@"
  else
    docker "$@"
  fi
}

build_inner_script='
set -euo pipefail
cd /workspace

if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

echo "==> Bundle dist"
rm -rf dist
NODE_ENV=production node esbuild.js
NODE_ENV=production node esbuild-config.js

PKG_BIN="./node_modules/.bin/pkg"
if [[ ! -x "${PKG_BIN}" ]]; then
  echo "pkg not found: ${PKG_BIN}" >&2
  exit 1
fi

OUT_DIR="build/${BUILD_VERSION}"
rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"

build_target() {
  local name="$1"
  local target="$2"
  local ext="$3"
  local out="${OUT_DIR}/${name}${ext}"
  echo "==> build ${name}${ext} (${target})"
  CI=1 PKG_DISABLE_PROGRESS=1 "${PKG_BIN}" ./standalone.cjs --targets "${target}" --output "${out}" || \
  CI=1 PKG_DISABLE_PROGRESS=1 "${PKG_BIN}" ./standalone.cjs --no-progress --targets "${target}" --output "${out}"
}

build_target "catpawrunner_linux_amd64"      "node18-linux-x64"         ""
build_target "catpawrunner_linux_arm64"      "node18-linux-arm64"       ""
build_target "catpawrunner_linux_musl_amd64" "node18-linuxstatic-x64"   ""
build_target "catpawrunner_linux_musl_arm64" "node18-linuxstatic-arm64" ""
build_target "catpawrunner_windows_amd64"    "node18-win-x64"           ".exe"
build_target "catpawrunner_windows_arm64"    "node18-win-arm64"         ".exe"

echo "==> Artifacts"
ls -lh "${OUT_DIR}"
'

build_with_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker not found" >&2
    exit 1
  fi

  docker_cmd run --rm \
    -e BUILD_VERSION="${VERSION}" \
    -e HTTP_PROXY="${HTTP_PROXY}" \
    -e HTTPS_PROXY="${HTTPS_PROXY}" \
    -e ALL_PROXY="${ALL_PROXY}" \
    -e NO_PROXY="${NO_PROXY}" \
    -e http_proxy="${HTTP_PROXY}" \
    -e https_proxy="${HTTPS_PROXY}" \
    -e all_proxy="${ALL_PROXY}" \
    -e no_proxy="${NO_PROXY}" \
    -v "${HOST_PROJECT_DIR}:/workspace" \
    -w /workspace \
    "${NODE_IMAGE}" \
    bash -lc "${build_inner_script}"
}

build_local() {
  cd "${SCRIPT_DIR}"
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "local build requires node and npm in PATH" >&2
    exit 1
  fi
  BUILD_VERSION="${VERSION}" bash -lc "${build_inner_script}"
}

echo "==> Release build start: ${VERSION}"
if [[ "${USE_DOCKER}" == "1" ]]; then
  build_with_docker
else
  build_local
fi

if [[ "${OUT_VERSION_DIR}" != "${SCRIPT_DIR}/build/${VERSION}" ]]; then
  rm -rf "${OUT_VERSION_DIR}"
  mkdir -p "${OUT_VERSION_DIR}"
  cp -a "${SCRIPT_DIR}/build/${VERSION}/." "${OUT_VERSION_DIR}/"
fi

echo "==> Done"
echo "output: ${OUT_VERSION_DIR}"

