#!/bin/bash
set -e

BACKUP_SOURCE_DIR="${BACKUP_SOURCE_DIR:-${PRODUCTION_BUILD_PATH:-../../web/static/prod}}"
BACKUP_TARGET="${BACKUP_TARGET:-production}"
BACKUP_COMMIT_SHORT_SHA="${BACKUP_COMMIT_SHORT_SHA:-unknown}"
ARCHIVE_DIR="${ASTRO_BUILD_STATIC_ARCHIVE_DIR:-${ASTRO_BUILD_ARCHIVE_DIR:-./build-archives}/static-backup}"
ARCHIVE_PATH="${ARCHIVE_DIR%/}/abcnorio-astro-${BACKUP_TARGET}-$(date +%Y%m%d-%H%M%S)-${BACKUP_COMMIT_SHORT_SHA}.zip"

if [[ "$ARCHIVE_DIR" != /* ]]; then
  ARCHIVE_DIR="$(pwd)/${ARCHIVE_DIR#./}"
fi
mkdir -p "$ARCHIVE_DIR"

if [ ! -d "$BACKUP_SOURCE_DIR" ]; then
  echo "No existing build directory at $BACKUP_SOURCE_DIR; skipping backup."
  exit 0
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "zip command not found; install zip to enable backup."
  exit 1
fi

SOURCE_PARENT_DIR="$(dirname "$BACKUP_SOURCE_DIR")"
SOURCE_BASENAME="$(basename "$BACKUP_SOURCE_DIR")"

FULL_ARCHIVE_PATH="$ARCHIVE_PATH"
if [[ "$FULL_ARCHIVE_PATH" != /* ]]; then
  FULL_ARCHIVE_PATH="$(pwd)/${FULL_ARCHIVE_PATH#./}"
fi
(
  cd "$SOURCE_PARENT_DIR"
  zip -qr "$FULL_ARCHIVE_PATH" "$SOURCE_BASENAME"
)
