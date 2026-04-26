#!/bin/bash
set -e

umask 0002

TARGET="${1:-}"

case "$TARGET" in
  dev)
    MODE=development
    BUILD_PATH="${DEV_BUILD_PATH:-}"
    ;;
  staging)
    MODE=staging
    BUILD_PATH="${STAGING_BUILD_PATH:-}"
    ;;
  production)
    MODE=production
    BUILD_PATH="${PRODUCTION_BUILD_PATH:-}"
    ;;
  *)
    echo "Invalid target: $TARGET (expected: dev|staging|production)"
    exit 1
    ;;
esac

echo "${HOME} Deploying Astro in ${MODE} mode... at ${BUILD_PATH}"

if [ -n "${BUILD_PATH}" ] && [ -d "${BUILD_PATH}" ]; then
    npm install
    rm -rf ./dist
    export MODE
    export BACKUP_TARGET="${TARGET}"
    export BACKUP_SOURCE_DIR="${BUILD_PATH}"
    export ASTRO_BUILD_BACKUP=1
    bash "${ORCHESTRATOR_SCRIPT_ROOT:-/orchestrator/scripts}/backup-build.sh"
    npm run build:site
    find "${BUILD_PATH}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    cp -R ./dist/. "${BUILD_PATH}/"
else
    echo "Build path not set or missing for target=${TARGET}. Skipping Astro build."
fi
