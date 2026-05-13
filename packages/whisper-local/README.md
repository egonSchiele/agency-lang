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
transcribe(filepath: string, language: string = "", model: string = "base.en"): string
```

- `filepath` — any audio file ffmpeg can read (mp3, m4a, wav, flac, ogg, webm, mp4, …). Must be a regular file on the local filesystem; URLs and ffmpeg pseudo-protocols (`http://`, `concat:`, `subfile:`, …) are explicitly rejected. See [Operational notes](#operational-notes).
- `language` — ISO 639-1 code (e.g. `"en"`, `"fr"`, `"de"`). Empty string → whisper.cpp auto-detects.
- `model` — model name. See the table below.

Returns the joined transcript text. Throws on missing ffmpeg, unknown model, corrupted audio, or SHA-256 mismatch on model download.

## Models

| Name | Size | English-only | Notes |
|------|------|--------------|-------|
| `tiny` | 75 MB | no | Fastest, lowest accuracy. Good for quick prototypes. |
| `tiny.en` | 75 MB | yes | English-only variant of `tiny`; slightly more accurate. |
| `base.en` | 142 MB | yes | Recommended default. Good accuracy/speed trade-off. |

Other whisper.cpp models (`base`, `small`, `small.en`, `medium`, `medium.en`, `large-v3`, `large-v3-turbo`) are supported by the underlying engine but are not yet pinned in `models.lock.json`. They will be added as we verify each upstream release. To add one yourself, see [`docs/DEV.md`](./docs/DEV.md#adding-a-model).

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

## Operational notes

**Threading.** The native addon runs whisper inference on a libuv worker thread (`Napi::AsyncWorker`), so the JavaScript event loop is *not* blocked during a `transcribe()` call. Other JS work — HTTP requests, timers, etc. — continues to run.

**Per-model serialization.** A `whisper_context` is mutable internal state. We hold a per-model mutex around `whisper_full`, so concurrent `transcribe()` calls on the *same* model serialize cleanly (no races, no corruption) but do not run in parallel. Throughput per model is single-threaded.

**Cross-model parallelism.** Calls on *different* model instances run concurrently on separate libuv worker threads. By default Node sizes the libuv pool at 4 threads. If you run many concurrent transcriptions in the same process (e.g. an Agency program serving multiple users), bump the pool: `UV_THREADPOOL_SIZE=16 node ...` Do this *before* node starts; the pool size is locked at startup.

**Loaded-model cache.** Loaded model contexts are kept in an in-process LRU cache. The default cap is 2 entries (a `large-v3` context can use ~3 GB, so an unbounded cache is dangerous in long-lived processes). Override via `AGENCY_WHISPER_HANDLE_CACHE_MAX`. Set to `0` to disable the cache (load + free per `transcribe()`).

**Memory profile.** The audio decode step buffers the entire decoded PCM in memory before handing it to whisper. At 16 kHz mono float32 that is ~230 MB per hour of audio. Peak RSS during a transcribe is roughly 3× the decoded size (decoded buffer + Float32Array copy + C++ `std::vector` copy). The package rejects any single decode that exceeds 2 GB by default; override per-call via the lower-level `decodeToPcm({ maxPcmBytes })` API or chunk long audio client-side.

**Timeout.** Each ffmpeg invocation has a 10-minute wall-clock cap (configurable via `decodeToPcm({ timeoutMs })`). On expiry the ffmpeg process is `SIGKILL`-ed and the call rejects, so a stuck or pathological input cannot hold the worker forever.

**Input restriction.** `transcribe(filepath)` validates that `filepath` is a regular file before spawning ffmpeg, and the spawn is restricted to ffmpeg's `file` protocol. Inputs starting with `-` or specifying any other protocol (`http://`, `tcp://`, `concat:`, `subfile:`, …) are rejected up front. This matters because Agency programs often pass LLM-driven tool arguments straight into `transcribe()`; without this guard, a crafted "filepath" could turn a transcription into an outbound HTTP fetch or a read of an arbitrary local file.

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
