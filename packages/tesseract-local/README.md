# @agency-lang/tesseract-local

Offline OCR for Agency. No network after the first run, no API key, no data leaves your machine.

## Installation

```sh
npm install @agency-lang/tesseract-local
```

`tesseract.js` is WebAssembly, so there is no compiler, no native addon, and no build step. The package installs on macOS, Linux, and Windows.

## Usage

```ts
import { readText } from "pkg::@agency-lang/tesseract-local"

node main() {
  const text = readText("scan.png")
  print(text)
}
```

The first call downloads English language data (about 4 MB) into `~/.agency/models/tesseract/` (override with `AGENCY_TESSERACT_MODELS_DIR`) and checks it against the SHA-256 in `models.lock.json`. A mismatch deletes the download and fails. Later calls read the local file with no network access. The worker and the WebAssembly core load from `node_modules`; only language data is fetched.

## Languages

| Name  | Source                                        | Size   |
|-------|-----------------------------------------------|--------|
| `eng` | `tessdata_fast` at commit `87416418657359cb…` | 4.1 MB |

To add a language, run the lockfile script with the `tessdata_fast` commit you want to pin, confirm the printed hash against the repository, paste the row into `models.lock.json`, and add the name to `KNOWN_LANGUAGES` in `src/types.ts`:

```sh
TESSDATA_COMMIT=<40-char-sha> bash scripts/generate-lockfile.sh fra
```

## Dependencies

`tesseract.js` is pinned to the exact version `7.0.0`, the newest release at the time of writing and older than the workspace's seven-day release cooldown. Bump it deliberately: the `createWorker` signature has changed between majors.

## Containment

The image is read through `agency-lang`'s `contained` module, which refuses a symlink at the final name and anything that is not a regular file, and the worker receives the bytes rather than a path. The function raises no interrupt. A caller who wants approval wraps the call in a handler.
