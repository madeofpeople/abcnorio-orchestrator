#!/bin/bash
set -e

umask 0002

TARGET="${1:-}"
SCOPE="${2:-full}"

if [[ "$SCOPE" != "full" && "$SCOPE" != "events" ]]; then
  if [[ ! "$SCOPE" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    echo "Invalid scope: $SCOPE"
    exit 1
  fi
fi

case "$TARGET" in
  dev)
    MODE=development
    BUILD_PATH="${DEV_BUILD_PATH:-}"
    BUILD_CACHE_TTL_MS=0
    ;;
  staging)
    MODE=staging
    BUILD_PATH="${STAGING_BUILD_PATH:-}"
    BUILD_CACHE_TTL_MS=0
    ;;
  production)
    MODE=production
    BUILD_PATH="${PRODUCTION_BUILD_PATH:-}"
    BUILD_CACHE_TTL_MS=0
    ;;
  preview)
    MODE=preview
    BUILD_PATH="${PREVIEW_BUILD_PATH:-}"
    BUILD_CACHE_TTL_MS=0
    ;;
  *)
    echo "Invalid target: $TARGET (expected: dev|staging|production|preview)"
    exit 1
    ;;
esac

echo "Deploying Astro in ${MODE} mode (scope=${SCOPE})... at ${BUILD_PATH}"

if [ -n "${BUILD_PATH}" ] && [ -d "${BUILD_PATH}" ]; then
    if [[ ! -d node_modules ]]; then
      npm install
    fi
    rm -rf ./dist
    export MODE
    export SCOPE
    export BUILD_CACHE_TTL_MS
    export BACKUP_TARGET="${TARGET}"
    export BACKUP_SOURCE_DIR="${BUILD_PATH}"
    export ASTRO_BUILD_BACKUP=1
    bash "${ORCHESTRATOR_SCRIPT_ROOT:-/orchestrator/scripts}/backup-build.sh"
    npm run build:site

    if [[ "$SCOPE" != "full" ]]; then
      if [[ -d "./dist/client/${SCOPE}" ]]; then
        rm -rf "${BUILD_PATH}/client/${SCOPE}"
        cp -R "./dist/client/${SCOPE}" "${BUILD_PATH}/client/${SCOPE}"
        if [[ -d "./dist/client/_astro" ]]; then
          rm -rf "${BUILD_PATH}/client/_astro"
          cp -R "./dist/client/_astro" "${BUILD_PATH}/client/_astro"
        fi
      else
        echo "Scoped output ./dist/client/${SCOPE} not found; falling back to full deploy."
        find "${BUILD_PATH}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
        cp -R ./dist/. "${BUILD_PATH}/"
      fi
    else
      find "${BUILD_PATH}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
      cp -R ./dist/. "${BUILD_PATH}/"
    fi

    if [[ "$TARGET" == "production" ]]; then
      echo "$(date -u +%Y%m%dT%H%M%SZ)" > "${BUILD_PATH}/.deploy-version"
      echo "Warming production caches..."
      bash "${ORCHESTRATOR_SCRIPT_ROOT:-/orchestrator/scripts}/warm-cache.sh" || echo "Cache warm failed (non-fatal)"
    fi

else
    echo "Build path not set or missing for target=${TARGET}. Skipping Astro build."
fi
