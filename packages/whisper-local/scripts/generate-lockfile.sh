#!/usr/bin/env bash
# Downloads each whisper model, records SHA-256 + size into models.lock.json.
# Idempotent: re-running it overwrites the lockfile but uses the same URLs.
#
# Usage: HF_COMMIT=<40-char-sha> bash scripts/generate-lockfile.sh
#
# Optional: set MODELS to a space-separated subset to populate only specific
# rows (others retain their existing entries from models.lock.json).
set -euo pipefail

if [ -z "${HF_COMMIT:-}" ]; then
  echo "HF_COMMIT env var required (40-char HuggingFace commit SHA)"
  exit 1
fi

PKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

DEFAULT_MODELS=(tiny tiny.en base base.en small small.en medium medium.en large-v3 large-v3-turbo)
read -r -a MODELS <<< "${MODELS:-${DEFAULT_MODELS[*]}}"

# Read the existing lockfile so we can update only the requested entries.
EXISTING="$PKG_ROOT/models.lock.json"
if [ ! -f "$EXISTING" ]; then
  echo "models.lock.json must exist (with at least the placeholder structure)"
  exit 1
fi

OUT_JSON=$(mktemp)
echo "{" > "$OUT_JSON"
echo '  "schemaVersion": 1,' >> "$OUT_JSON"
echo '  "models": {' >> "$OUT_JSON"

ALL_MODELS=(tiny tiny.en base base.en small small.en medium medium.en large-v3 large-v3-turbo)
SEP=""
for m in "${ALL_MODELS[@]}"; do
  IS_TARGET=0
  for t in "${MODELS[@]}"; do
    if [ "$t" = "$m" ]; then IS_TARGET=1; break; fi
  done

  URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/$HF_COMMIT/ggml-$m.bin"
  if [ "$IS_TARGET" = "1" ]; then
    echo "Downloading $URL ..."
    curl -fSL "$URL" -o "$TMP/$m.bin"
    SHA=$(shasum -a 256 "$TMP/$m.bin" | awk '{print $1}')
    SIZE=$(stat -f %z "$TMP/$m.bin" 2>/dev/null || stat -c %s "$TMP/$m.bin")
  else
    # Keep existing entry from models.lock.json.
    SHA=$(node -e "const j=require('$EXISTING'); console.log(j.models['$m'].sha256)")
    SIZE=$(node -e "const j=require('$EXISTING'); console.log(j.models['$m'].sizeBytes)")
    EXIST_URL=$(node -e "const j=require('$EXISTING'); console.log(j.models['$m'].url)")
    URL="$EXIST_URL"
  fi
  printf '%s    "%s": { "url": "%s", "sha256": "%s", "sizeBytes": %s }\n' \
    "$SEP" "$m" "$URL" "$SHA" "$SIZE" >> "$OUT_JSON"
  SEP=","
done

echo "  }" >> "$OUT_JSON"
echo "}" >> "$OUT_JSON"

# Pretty-print and write back.
node -e "const fs=require('fs'); const p='$OUT_JSON'; fs.writeFileSync('$EXISTING', JSON.stringify(JSON.parse(fs.readFileSync(p,'utf8')), null, 2)+'\\n');"

echo "Lockfile written to $EXISTING"
echo "Total download: $(du -sh $TMP 2>/dev/null | awk '{print $1}')"
