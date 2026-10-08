#!/bin/bash
set -e

umask 0002

RELEASE_PARENT=""
cleanup_release_parent() {
  if [[ -n "$RELEASE_PARENT" ]]; then
    rm -rf -- "$RELEASE_PARENT"
  fi
}
trap cleanup_release_parent EXIT

TARGET="${1:-}"
SCOPE="${2:-full}"
SOURCE_COMMIT_SHA="${SOURCE_COMMIT_SHA:-unknown}"
SOURCE_COMMIT_SHORT_SHA="${SOURCE_COMMIT_SHA:0:7}"

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
    cp ./package-lock.json "${temp_runtime_path}/package-lock.json"
    (
      cd "${temp_runtime_path}"
      npm ci --omit=dev
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
  if [[ ! -f ./package-lock.json ]]; then
    echo "package-lock.json is required for deterministic builds"
    exit 1
  fi
    npm ci
    rm -rf ./dist
    export MODE
    export SCOPE
    export BUILD_CACHE_TTL_MS
    if [[ "$TARGET" == "production" ]]; then
      export BACKUP_TARGET="production"
      export BACKUP_SOURCE_DIR="${BUILD_PATH}"
      bash "${ORCHESTRATOR_SCRIPT_ROOT:-/orchestrator/scripts}/backup-build.sh"
    fi
    npm run build

    RELEASE_PARENT="$(mktemp -d "${WORKDIR}/.release-output.XXXXXX")"
    RELEASE_ROOT="${RELEASE_PARENT}/$(basename "${BUILD_PATH}")"
    mkdir -p "${RELEASE_ROOT}"

    if [[ "$SCOPE" != "full" && -d "${BUILD_PATH}" ]]; then
      cp -R "${BUILD_PATH}/." "${RELEASE_ROOT}/"
    fi

    if [[ "$TARGET" == "production" ]]; then
      mkdir -p "${RELEASE_ROOT}/client"
      if [[ "$SCOPE" != "full" ]]; then
        if [[ -d "./dist/client/${SCOPE}" ]]; then
          rm -rf "${RELEASE_ROOT}/client/${SCOPE}"
          cp -R "./dist/client/${SCOPE}" "${RELEASE_ROOT}/client/${SCOPE}"
          if [[ -d "./dist/client/_astro" ]]; then
            rm -rf "${RELEASE_ROOT}/client/_astro"
            cp -R "./dist/client/_astro" "${RELEASE_ROOT}/client/_astro"
          fi
        else
          echo "Scoped output ./dist/client/${SCOPE} not found; falling back to full deploy."
          find "${RELEASE_ROOT}" -mindepth 1 -maxdepth 1 ! -name '.ssr' -exec rm -rf {} +
          mkdir -p "${RELEASE_ROOT}/client"
          cp -R ./dist/client/. "${RELEASE_ROOT}/client/"
        fi
      else
        find "${RELEASE_ROOT}" -mindepth 1 -maxdepth 1 ! -name '.ssr' -exec rm -rf {} +
        mkdir -p "${RELEASE_ROOT}/client"
        cp -R ./dist/client/. "${RELEASE_ROOT}/client/"
      fi

      stage_production_ssr_runtime "${RELEASE_ROOT}/.ssr"
    else
      if [[ "$SCOPE" != "full" ]]; then
        if [[ -d "./dist/client/${SCOPE}" ]]; then
          rm -rf "${RELEASE_ROOT}/client/${SCOPE}"
          cp -R "./dist/client/${SCOPE}" "${RELEASE_ROOT}/client/${SCOPE}"
          if [[ -d "./dist/client/_astro" ]]; then
            rm -rf "${RELEASE_ROOT}/client/_astro"
            cp -R "./dist/client/_astro" "${RELEASE_ROOT}/client/_astro"
          fi
        else
          echo "Scoped output ./dist/client/${SCOPE} not found; falling back to full deploy."
          find "${RELEASE_ROOT}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
          cp -R ./dist/. "${RELEASE_ROOT}/"
        fi
      else
        find "${RELEASE_ROOT}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
        cp -R ./dist/. "${RELEASE_ROOT}/"
      fi
    fi

    RELEASE_ID="$(date -u +%Y%m%d-%H%M%S)-${SOURCE_COMMIT_SHORT_SHA:-unknown}"
    ARCHIVE_DIR="${ASTRO_BUILD_STATIC_ARCHIVE_DIR:-${ASTRO_BUILD_ARCHIVE_DIR:-./build-archives}/static-backup}"
    mkdir -p "$ARCHIVE_DIR"
    ARCHIVE_PATH="${ARCHIVE_DIR%/}/abcnorio-astro-${TARGET}-${RELEASE_ID}.zip"
    (cd "$RELEASE_PARENT" && zip -qr "$ARCHIVE_PATH" "$(basename "${BUILD_PATH}")")
    echo "Built release archive: $ARCHIVE_PATH"
    echo "release_id=$RELEASE_ID"

else
    echo "Build path not set or missing for target=${TARGET}. Skipping Astro build."
fi
