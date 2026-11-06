#!/usr/bin/env bash
# Fetch the published game-data repo into ./data at the tag in DATA_VERSION.
#
#   npm run data:fetch
#
# SUMIRE_DATA_REPO overrides the repository URL (useful for a local checkout):
#   SUMIRE_DATA_REPO=/path/to/sumire-sr-data npm run data:fetch
#
# Re-running is safe: an existing checkout at the requested tag is left alone.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/data"
REPO="${SUMIRE_DATA_REPO:-https://github.com/project-hoshimi/sumire-sr-data}"

die() {
  echo "fetch-data: $*" >&2
  exit 1
}

[[ -f "$ROOT/DATA_VERSION" ]] || die "DATA_VERSION is missing"
TAG="${SUMIRE_DATA_TAG:-$(tr -d '[:space:]' < "$ROOT/DATA_VERSION")}"
[[ -n "$TAG" ]] || die "DATA_VERSION is empty"

if [[ -d "$DEST/.git" ]]; then
  current="$(git -C "$DEST" describe --tags --exact-match 2>/dev/null || true)"
  if [[ "$current" == "$TAG" ]]; then
    echo "fetch-data: $DEST already at $TAG"
  else
    echo "fetch-data: updating $DEST to $TAG"
    git -C "$DEST" fetch --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG"
    git -C "$DEST" checkout -q "tags/$TAG"
  fi
else
  if [[ -e "$DEST" && -n "$(ls -A "$DEST" 2>/dev/null)" ]]; then
    die "$DEST exists and is not a git checkout; move it away first"
  fi
  echo "fetch-data: cloning $REPO at $TAG into $DEST"
  git clone --depth 1 --branch "$TAG" "$REPO" "$DEST"
fi

for required in phaseA2/out/manifest.json captures/identity.json diaries.json; do
  [[ -f "$DEST/$required" ]] || die "$DEST is missing $required"
done

echo "fetch-data: ready at $DEST"
