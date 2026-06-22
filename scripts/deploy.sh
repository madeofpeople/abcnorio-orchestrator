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
    SSR_RUNTIME_PATH=""
    ;;
  staging)
    MODE=staging
    BUILD_PATH="${STAGING_BUILD_PATH:-}"
    BUILD_CACHE_TTL_MS=0
    SSR_RUNTIME_PATH=""
    ;;
  production)
    MODE=production
    BUILD_PATH="${PRODUCTION_BUILD_PATH:-}"
    BUILD_CACHE_TTL_MS=0
    SSR_RUNTIME_PATH="${BUILD_PATH}/.ssr"
    ;;
  preview)
    MODE=preview
    BUILD_PATH="${PREVIEW_BUILD_PATH:-}"
    BUILD_CACHE_TTL_MS=0
    SSR_RUNTIME_PATH=""
    ;;
  *)
    echo "Invalid target: $TARGET (expected: dev|staging|production|preview)"
    exit 1
    ;;
esac

echo "Deploying Astro in ${MODE} mode (scope=${SCOPE})... at ${BUILD_PATH}"

stage_production_ssr_runtime() {
    local runtime_path="$1"
    local temp_runtime_path="${runtime_path}.staging"

    echo "Refreshing production SSR runtime at ${runtime_path}..."
    rm -rf "${temp_runtime_path}"
    mkdir -p "${temp_runtime_path}"
    cp ./package.json "${temp_runtime_path}/package.json"
    (
      cd "${temp_runtime_path}"
      npm install --omit=dev --package-lock=false
    )
    cp -R ./dist/server "${temp_runtime_path}/server"
    cp -R ./dist/client "${temp_runtime_path}/client"
    echo "$(date -u +%Y%m%dT%H%M%SZ)" > "${temp_runtime_path}/.deploy-version"

    mkdir -p "${runtime_path}"
    find "${runtime_path}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

    for staged_entry in "${temp_runtime_path}"/* "${temp_runtime_path}"/.[!.]* "${temp_runtime_path}"/..?*; do
      if [ ! -e "$staged_entry" ]; then
        continue
      fi
      if [ "$(basename "$staged_entry")" = '.deploy-version' ]; then
        continue
      fi
      cp -R "$staged_entry" "${runtime_path}/"
    done

    cp "${temp_runtime_path}/.deploy-version" "${runtime_path}/.deploy-version"
    rm -rf "${temp_runtime_path}"
}

if [ -n "${BUILD_PATH}" ] && [ -d "${BUILD_PATH}" ]; then
  rm -rf ./abcnorio-webcomponents
  cp -R /abcnorio-webcomponents ./abcnorio-webcomponents
  rm -rf ./abcnorio-webcomponents/node_modules
  npm pkg set dependencies.abcnorio-webcomponents='file:./abcnorio-webcomponents'
    npm install --package-lock=false
    rm -rf ./dist
    export MODE
    export SCOPE
    export BUILD_CACHE_TTL_MS
    export BACKUP_TARGET="${TARGET}"
    export BACKUP_SOURCE_DIR="${BUILD_PATH}"
    export ASTRO_BUILD_BACKUP=1
    bash "${ORCHESTRATOR_SCRIPT_ROOT:-/orchestrator/scripts}/backup-build.sh"
    npm run build

    if [[ "$TARGET" == "production" ]]; then
      mkdir -p "${BUILD_PATH}/client"
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
          find "${BUILD_PATH}" -mindepth 1 -maxdepth 1 ! -name '.ssr' -exec rm -rf {} +
          mkdir -p "${BUILD_PATH}/client"
          cp -R ./dist/client/. "${BUILD_PATH}/client/"
        fi
      else
        find "${BUILD_PATH}" -mindepth 1 -maxdepth 1 ! -name '.ssr' -exec rm -rf {} +
        mkdir -p "${BUILD_PATH}/client"
        cp -R ./dist/client/. "${BUILD_PATH}/client/"
      fi

      stage_production_ssr_runtime "${SSR_RUNTIME_PATH}"
    else
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
    fi

    if [[ "$TARGET" == "production" ]]; then
      STAGING_UPL="${STAGING_UPLOADS_DIR:-}"
      PROD_UPLOADS="${PRODUCTION_UPLOADS_PATH:-}"
      if [[ -n "$STAGING_UPL" && -d "$STAGING_UPL" && -n "$PROD_UPLOADS" ]]; then
        echo "Syncing uploads to production..."
        mkdir -p "$PROD_UPLOADS"
        cp -Ru "$STAGING_UPL/." "$PROD_UPLOADS/"
        echo "Uploads synced."
      fi
      echo "Warming production caches..."
      bash "${ORCHESTRATOR_SCRIPT_ROOT:-/orchestrator/scripts}/warm-cache.sh" || echo "Cache warm failed (non-fatal)"
    fi

else
    echo "Build path not set or missing for target=${TARGET}. Skipping Astro build."
fi
