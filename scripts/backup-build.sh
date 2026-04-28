#!/bin/bash
set -e

BACKUP_SOURCE_DIR="${BACKUP_SOURCE_DIR:-${PRODUCTION_BUILD_PATH:-../../web/static/prod}}"
BACKUP_TARGET="${BACKUP_TARGET:-production}"
ARCHIVE_DIR="./build-archives"
ARCHIVE_PATH="${ARCHIVE_DIR}/abcnorio-astro-${BACKUP_TARGET}-$(date +%Y%m%d-%H%M%S).zip"

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

FULL_ARCHIVE_PATH="$(pwd)/${ARCHIVE_PATH#./}"
(
  cd "$SOURCE_PARENT_DIR"
  zip -qr "$FULL_ARCHIVE_PATH" "$SOURCE_BASENAME"
)
