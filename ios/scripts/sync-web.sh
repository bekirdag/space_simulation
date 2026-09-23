#!/usr/bin/env bash
# Copies the production web build (dist/) into the iOS app's bundled Web/ folder.
# Run from the repository root after `npm run build`:
#   npm run build && ios/scripts/sync-web.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="${REPO_ROOT}/dist"
DEST="${REPO_ROOT}/ios/CosmosMap/Web"

if [[ ! -f "${SRC}/index.html" ]]; then
  echo "error: ${SRC}/index.html not found. Run 'npm run build' first." >&2
  exit 1
fi

mkdir -p "${DEST}"
# --delete keeps Web/ an exact mirror; macOS metadata files are never shipped.
rsync -a --delete \
  --exclude '.DS_Store' \
  --exclude '._*' \
  "${SRC}/" "${DEST}/"

# The bundle is read-only at runtime; make sure nothing in it is a symlink pointing outside.
if find "${DEST}" -type l | grep -q .; then
  echo "error: ${DEST} contains symlinks; the app server refuses to follow them outside Web/." >&2
  find "${DEST}" -type l >&2
  exit 1
fi

FILES=$(find "${DEST}" -type f | wc -l | tr -d ' ')
SIZE=$(du -sh "${DEST}" | cut -f1)
echo "Synced ${FILES} files (${SIZE}) from dist/ to ios/CosmosMap/Web/"
