#!/usr/bin/env bash
# Vendors a pinned whisper.cpp release into vendor/whisper.cpp/.
# Usage: bash scripts/vendor-whisper.sh v1.7.6
set -euo pipefail

TAG="${1:?usage: $0 <tag, e.g. v1.7.6>}"
PKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="$PKG_ROOT/vendor/whisper.cpp"
WORK=$(mktemp -d)
trap "rm -rf $WORK" EXIT

URL="https://github.com/ggml-org/whisper.cpp/archive/refs/tags/$TAG.tar.gz"
echo "Downloading $URL ..."
curl -fsSL "$URL" -o "$WORK/wsp.tar.gz"

ACTUAL=$(shasum -a 256 "$WORK/wsp.tar.gz" | awk '{print $1}')
echo "Downloaded SHA-256: $ACTUAL"
echo "Save this hash into vendor/whisper.cpp/UPSTREAM_SHA256 and verify against the GitHub release page before committing."

tar -xzf "$WORK/wsp.tar.gz" -C "$WORK"
SRC=$(echo "$WORK"/whisper.cpp-*)

rm -rf "$VENDOR_DIR"
mkdir -p "$VENDOR_DIR"

# Copy the full upstream source tree. We need src/, include/, ggml/, cmake/
# (referenced by the top-level CMakeLists), the top-level CMakeLists itself,
# and LICENSE. Excluding examples/, tests/, bindings/, models/ keeps the vendor
# tree small and avoids dragging in shipped model binaries or other ecosystems.
for d in src include ggml cmake; do
  if [ -d "$SRC/$d" ]; then
    cp -R "$SRC/$d" "$VENDOR_DIR/"
  fi
done
cp "$SRC/LICENSE"        "$VENDOR_DIR/LICENSE"
cp "$SRC/CMakeLists.txt" "$VENDOR_DIR/CMakeLists.txt"

echo "$TAG"    > "$VENDOR_DIR/VERSION"
echo "$ACTUAL" > "$VENDOR_DIR/UPSTREAM_SHA256"

echo "Done. Inspect $VENDOR_DIR, then commit."
