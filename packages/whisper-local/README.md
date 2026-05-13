# @agency-lang/whisper-local

Local Whisper transcription for Agency. No network at runtime, no API key, no data leaves your machine.

## Installation

This package ships as source and ships **no** install/postinstall scripts — `npm install` will not run a compiler or fetch anything. After installing, run the explicit build step below to compile the native addon. This is intentional: postinstall scripts are the most common npm supply-chain attack vector, and silently invoking `cmake` on every install would surprise users who pulled the package as a transitive dependency.

```sh
# 1. Install (no compilation, no network beyond the npm download itself)
npm install @agency-lang/whisper-local

# 2. Explicitly build the native addon (one-time, ~30-90 seconds)
npx -p @agency-lang/whisper-local agency-whisper build
```

**System dependencies (install before running `agency-whisper build`):**

| Platform | Build tools | Audio decoding |
|----------|-------------|----------------|
| macOS    | `xcode-select --install && brew install cmake` | `brew install ffmpeg` |
| Debian/Ubuntu | `sudo apt install cmake build-essential` | `sudo apt install ffmpeg` |
| Fedora   | `sudo dnf install cmake gcc-c++` | `sudo dnf install ffmpeg` |
| Windows  | Not yet supported in source-build v0; wait for prebuilts. | — |

If `agency-whisper build` fails because of missing build tools, the rest of your `node_modules/` is unaffected.

## Quick start

```ts
import { transcribe } from "pkg::@agency-lang/whisper-local"

node main() {
  const text = transcribe("interview.m4a", "en", "base.en")
  print(text)
}
```

The first call downloads `ggml-base.en.bin` (~150 MB) into `~/.agency/models/whisper/`. Subsequent calls reuse the cached file.

## API

```
transcribe(filepath: string, language: string = "", model: string = "base"): string
```

- `filepath` — any audio file ffmpeg can read (mp3, m4a, wav, flac, ogg, webm, mp4, …)
- `language` — ISO 639-1 code (e.g. `"en"`, `"fr"`, `"de"`). Empty string → whisper.cpp auto-detects.
- `model` — model name. See the table below.

Returns the joined transcript text. Throws on missing ffmpeg, unknown model, corrupted audio, or SHA-256 mismatch on model download.

## Models

| Name | Size | English-only | Notes |
|------|------|--------------|-------|
| `tiny`, `tiny.en` | 75 MB | optional | Fastest, lowest accuracy. Good for quick prototypes. |
| `base`, `base.en` | 142 MB | optional | Recommended default. |
| `small`, `small.en` | 466 MB | optional | Noticeable accuracy bump. |
| `medium`, `medium.en` | 1.5 GB | optional | Slow on CPU; usable on Apple Silicon. |
| `large-v3` | 2.9 GB | no (multilingual) | Best accuracy. Use only with adequate RAM. |
| `large-v3-turbo` | 1.5 GB | no | Approaches large-v3 quality at ~half the size. |

`.en` variants are slightly more accurate on English-only audio. The default `base` is the multilingual variant.

## Pre-downloading models

```sh
npx -p @agency-lang/whisper-local agency-whisper pull base.en
npx -p @agency-lang/whisper-local agency-whisper list
npx -p @agency-lang/whisper-local agency-whisper verify base.en
```

## Manual model placement

If you can't reach HuggingFace (network-restricted environment, etc.), download `ggml-<name>.bin` yourself and place it at `~/.agency/models/whisper/ggml-<name>.bin`. The package will use it as-is, without re-hashing on every load. To verify a manually-placed file:

```sh
npx -p @agency-lang/whisper-local agency-whisper verify <name>
```

## Custom model directory

Set `AGENCY_WHISPER_MODELS_DIR` to use a directory other than `~/.agency/models/whisper/`.

## Troubleshooting

**`cmake: command not found`** — install cmake (see the install table).

**`ffmpeg not found on PATH`** — install ffmpeg (see the install table).

**`whisper_init_from_file_with_params failed`** — the `.bin` file is corrupted or not a whisper.cpp ggml format. Re-download with `agency-whisper pull <name>` or run `agency-whisper verify <name>` to check.

**`SHA-256 mismatch`** — the downloaded model's hash doesn't match the lockfile. The partial file has been deleted. Re-running usually succeeds; if it persists, file an issue.

**`whisper-local native addon not found`** — you skipped step 2 of installation. Run `npx -p @agency-lang/whisper-local agency-whisper build`.

## Not in v0

- Prebuilt binaries (will arrive via an optional-deps platform matrix).
- Windows source-build support.
- Streaming partial results.
- Speaker diarization.
- Translation mode.

## For maintainers / contributors

See [`docs/DEV.md`](./docs/DEV.md) for architecture, security model, C++ memory design, vendoring procedure, and testing notes.

## Credits

This package vendors and depends on:

- **[whisper.cpp](https://github.com/ggml-org/whisper.cpp)** by Georgi Gerganov and contributors — MIT License. See `vendor/whisper.cpp/LICENSE`. We use a pinned release; see `vendor/whisper.cpp/VERSION`.
- **[ggml](https://github.com/ggml-org/ggml)** by Georgi Gerganov and contributors — MIT License. Vendored alongside whisper.cpp.
- **[node-addon-api](https://github.com/nodejs/node-addon-api)** by the Node.js project — MIT License.
- **[cmake-js](https://github.com/cmake-js/cmake-js)** — MIT License.

Audio decoding shells out to your system's **[ffmpeg](https://ffmpeg.org)**, which is not bundled or distributed with this package.

## License

ISC. See repository root LICENSE file. Vendored whisper.cpp + ggml source is MIT-licensed; see `vendor/whisper.cpp/LICENSE` for that notice.
