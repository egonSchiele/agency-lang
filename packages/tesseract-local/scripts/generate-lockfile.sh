#!/usr/bin/env bash
# Downloads a tessdata_fast language file at a pinned commit and prints the
# lockfile row for it. Paste the row into models.lock.json and add the name
# to KNOWN_LANGUAGES in src/types.ts.
#
# Usage: TESSDATA_COMMIT=<40-char-sha> bash scripts/generate-lockfile.sh eng
set -euo pipefail

if [ -z "${TESSDATA_COMMIT:-}" ]; then
  echo "TESSDATA_COMMIT env var required (40-char commit SHA of tesseract-ocr/tessdata_fast)"
  exit 1
fi
LANG_NAME="${1:?language name required}"
URL="https://github.com/tesseract-ocr/tessdata_fast/raw/${TESSDATA_COMMIT}/${LANG_NAME}.traineddata"

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP"
SHA=$(shasum -a 256 "$TMP" | cut -d' ' -f1)
SIZE=$(wc -c < "$TMP" | tr -d ' ')

printf '    "%s": {\n      "url": "%s",\n      "sha256": "%s",\n      "sizeBytes": %s\n    }\n' \
  "$LANG_NAME" "$URL" "$SHA" "$SIZE"
