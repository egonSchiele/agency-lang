# whisper-local — Developer Documentation

This document captures architecture, design rationale, and gotchas for
maintainers of `@agency-lang/whisper-local`. Read it before making non-trivial
changes to the package.

## 1. Architecture overview

```diagram
╭──────────────────────────╮
│  Caller's .agency code   │
│  transcribe("audio.m4a") │
╰────────────┬─────────────╯
             │
             ▼
╭──────────────────────────╮     ╭──────────────────────────╮
│      index.agency        │────▶│    transcribe.ts (TS)    │
│  (one-line passthrough)  │     │ - decodeToPcm (ffmpeg.ts)│
╰──────────────────────────╯     │ - ensureModel (modelMgr) │
                                  │ - per-path handle cache  │
                                  ╰────────────┬─────────────╯
                                               │
                                               ▼
                                  ╭──────────────────────────╮
                                  │     addon.cc (C++17)     │
                                  │  N-API ↔ whisper.cpp     │
                                  │  AsyncWorker + mutex     │
                                  ╰────────────┬─────────────╯
                                               │
                                               ▼
                                  ╭──────────────────────────╮
                                  │  vendor/whisper.cpp +    │
                                  │  ggml (static libs)      │
                                  ╰──────────────────────────╯
```

Three layers, each with a clear single responsibility:

1. **Agency wrapper (`index.agency`).** Public surface for Agency callers.
   Intentionally a one-line passthrough so the type signature, defaults, and
   docstring live in one place.

2. **TypeScript orchestrator (`src/`).** Resolves model paths, downloads
   missing models with SHA verification, shells out to `ffmpeg` to decode
   audio to 16 kHz mono float PCM, and calls into the addon. Caches addon
   handles by model path so subsequent calls don't re-load weights.

3. **C++ N-API addon (`src/addon.cc`).** Wraps four whisper.cpp functions
   (`whisper_init_from_file_with_params`, `whisper_full`,
   `whisper_full_n_segments`, `whisper_full_get_segment_text`, `whisper_free`)
   behind a `WhisperModel` JS class. Runs inference on a libuv worker thread
   so it doesn't block the Node event loop.

The vendored `whisper.cpp` + `ggml` source lives under `vendor/whisper.cpp/`
and is compiled as static libraries via the upstream's own CMakeLists, then
linked into the addon `.node` file.

## 2. Trust model and security posture

This package's security boundary is small and explicit:

**The package does not run any code at install time.** There is no
`install`, `postinstall`, or `prepare` script in `package.json`. `npm install
@agency-lang/whisper-local` only copies files to disk. To compile the native
addon, the user must explicitly run `npx -p @agency-lang/whisper-local
agency-whisper build`. Rationale:
  - Postinstall scripts are the most common npm supply-chain attack vector.
  - Many CI environments and security-conscious users run `pnpm install
    --ignore-scripts` by default, which would silently leave a broken package.
  - Pulling this package as a transitive dep should never invoke a compiler.
  - Build failures (missing cmake / ffmpeg / Xcode CLT) shouldn't break
    unrelated `pnpm install` runs in the monorepo and CI.

**Models are downloaded over HTTPS only.** The `downloadModel` function
refuses non-HTTPS URLs (with a localhost exception for tests). This is
defense in depth on top of SHA-256 verification.

**Models are SHA-256 verified against a committed lockfile.**
`models.lock.json` contains `{ url, sha256, sizeBytes }` per model, with URLs
pinned to a specific HuggingFace commit SHA so the bytes can never change
under us. Downloads stream into `<dest>.partial`, hash as we go, and
atomically `rename` only after the SHA matches. Mismatches delete the partial
and throw with a clear message.

**Manually-placed models are trusted.** If `~/.agency/models/whisper/ggml-X.bin`
exists, we use it as-is — no re-hashing on every load (which would add
seconds to every cold start for large models). Users who pre-stage models
from a non-HuggingFace source can run `agency-whisper verify <name>` to
confirm against the lockfile. This is a deliberate convenience tradeoff:
the alternative (hash-on-every-load) is too slow.

**The vendored whisper.cpp source is reviewable.** It lives in `vendor/` in
the same repository, copyrights preserved, MIT LICENSE shipped. The
`UPSTREAM_SHA256` file records the SHA-256 of the upstream tarball at the
time of vendoring; it should be re-verified against the GitHub release page
before bumping.

**Third-party CI actions are pinned to commit SHA** in
`.github/workflows/whisper-local.yml`, mirroring the policy in the main
`test.yml`.

## 3. C++ memory model in the addon

This is the highest-risk part of the package. Read the comments at the top
of `src/addon.cc` — they document the failure modes and the design that
prevents each one.

### Three latent failure modes

1. **Use-after-free via JS GC.** Without a Persistent reference, the JS
   `WhisperModel` object can be GC'd while a `transcribe()` call is in
   flight on a libuv worker thread. The destructor would then run on the JS
   thread, calling `whisper_free(ctx_)`, leaving the worker holding a
   dangling pointer. This is a hard segfault (or worse — silent heap
   corruption).

2. **Use-after-free via explicit `model.free()`.** Same scenario, but
   triggered by user code calling `model.free()` between starting and
   awaiting `transcribe()`.

3. **Data race on concurrent calls to `whisper_full`.** The `whisper_context`
   is mutated by `whisper_full`. Two concurrent calls on the same context
   are undefined behavior. Because `transcribe.ts` reuses the same
   `WhisperModel` instance per model path (via the handle cache), this can
   happen if user code fires off two `transcribe()` calls without awaiting
   the first.

### The three-part fix

- **`Napi::ObjectReference modelRef_` in `TranscribeWorker`.** Created via
  `Napi::Persistent(info.This())`, this pins the JS WhisperModel object
  alive across the async boundary. JS GC cannot collect the model while a
  worker is queued. The reference is dropped in the worker's destructor on
  the JS thread.

- **`std::atomic<int> inflight_` on `WhisperModel`.** Incremented in the
  worker constructor, decremented in the destructor. `Free()` checks this
  counter and throws a JS error if non-zero, instead of freeing the context
  out from under a running worker. The `~WhisperModel` destructor is a
  safety net that skips the free if `inflight_ != 0` (which should never
  happen given the Persistent ref) — leaking the ctx is preferable to a
  use-after-free.

- **`std::mutex mu_` on `WhisperModel`.** `TranscribeWorker::Execute()`
  takes a `std::lock_guard` on this mutex before calling `whisper_full`.
  Two concurrent transcribe calls serialize cleanly. Callers who want
  concurrency should create separate `WhisperModel` instances (one per
  thread of work).

### PCM ownership

The Float32Array passed to `transcribe(pcm)` is JS-managed. We immediately
copy its contents into a `std::vector<float> pcm_` member on the worker so
the JS-managed buffer can be GC'd before `Execute()` runs. The vector is
moved into the worker, never copied again.

**Watch out for `ElementLength` vs `ByteLength`.** `Float32Array.ElementLength()`
returns the count of `float`s. `Float32Array.ByteLength()` returns 4× that.
We use the former in `addon.cc`. Using the latter would over-read by 4×
into adjacent memory.

### Errors in `Execute()`

`Napi::AsyncWorker::Execute()` runs off the JS thread. C++ `throw` there is
undefined. Always call `SetError(std::string)` instead; `OnError` translates
it into a JS Promise rejection on the JS thread.

## 4. Model lockfile and download path

`models.lock.json` is the trust anchor. It has the shape:

```json
{
  "schemaVersion": 1,
  "models": {
    "tiny": {
      "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/<HF_COMMIT>/ggml-tiny.bin",
      "sha256": "be07e048...",
      "sizeBytes": 77691713
    },
    ...
  }
}
```

URLs are pinned to a HuggingFace commit SHA, not `main`, so the byte
contents can never change under us. The current commit at vendoring time
was `5359861c739e955e79d9a303bcbc70fb988958b1` (Oct 2024).

`downloadModel(entry, dest)`:
1. Refuses non-HTTPS URLs (localhost exception for tests).
2. Streams `fetch(entry.url)` into `<dest>.partial` while computing SHA-256
   incrementally.
3. After the stream completes, compares the SHA. On mismatch: delete the
   partial and throw.
4. On success: atomically `rename(<dest>.partial, <dest>)`.

This ordering means if the process dies mid-download, the next run sees no
stale `.bin` file and just re-downloads. The `.partial` cleanup at the
start of `downloadModel` handles leftovers from a prior crashed attempt.

`ensureModel(name)` is the public API: it checks if the file is already on
disk and skips the download if so. Files that are present are trusted
without re-hashing — if you want to verify, run `agency-whisper verify`.

### Populating the lockfile

`scripts/generate-lockfile.sh` downloads each model and computes its SHA.
Usage:

```sh
HF_COMMIT=<40-char-sha> bash scripts/generate-lockfile.sh
# Or just specific models (others retain existing entries):
HF_COMMIT=<sha> MODELS="tiny tiny.en base.en" bash scripts/generate-lockfile.sh
```

<a id="adding-a-model"></a>
### Adding a model

The shipped lockfile and `KNOWN_MODELS` list (in `src/types.ts`) carry only
the three models we have actually verified end-to-end: `tiny`, `tiny.en`,
and `base.en`. To add another (e.g. `large-v3`):

1. Pick the upstream HuggingFace commit you want to pin to.
2. Run `HF_COMMIT=<sha> MODELS="large-v3" bash scripts/generate-lockfile.sh`.
3. Confirm the printed SHA against the upstream HuggingFace UI.
4. Add the model name to `KNOWN_MODELS` in `src/types.ts`.
5. Add a row to the Models table in `README.md`.

`ensureModel` retains a defensive guard: any lockfile entry with
`sha256: "0".repeat(64)` is rejected with a clear "lockfile not populated
yet" message. This is unreachable in shipped code (because such entries are
not in `KNOWN_MODELS`) but stays as belt-and-suspenders against a future
regression.

## 5. Vendoring procedure

`scripts/vendor-whisper.sh <tag>` downloads the upstream release tarball,
extracts it, copies `src/`, `include/`, `ggml/`, `cmake/`, `CMakeLists.txt`,
and `LICENSE` into `vendor/whisper.cpp/`, and writes `VERSION` +
`UPSTREAM_SHA256`.

**To bump whisper.cpp:**

1. Pick a new tag from https://github.com/ggml-org/whisper.cpp/releases.
2. Run `bash scripts/vendor-whisper.sh vX.Y.Z`.
3. Verify the printed SHA-256 against the GitHub release page (ideally from
   a separate network) — this is the moment to catch tarball tampering.
4. Re-run `pnpm run build:native` to confirm the upstream API hasn't broken
   our addon.
5. Re-run `AGENCY_RUN_SLOW=1 pnpm test:run tests/integration.test.ts` to
   confirm transcription still works.
6. Commit `vendor/whisper.cpp/`, `VERSION`, and `UPSTREAM_SHA256`.

**Why we copy source instead of using a git submodule:** vendoring keeps
the repo self-contained — `git clone && pnpm install && agency-whisper
build` works without any submodule dance. It also pins the exact bytes
under our review, with no possibility of an upstream rewriting history.

**Why `examples/`, `tests/`, `bindings/`, `models/` are excluded:** they
add ~100 MB of unrelated code (and pre-trained binary models in `models/`)
that we don't link against and don't want to ship.

## 6. The CMake build

`CMakeLists.txt` at the package root:
- Sets C++17 and PIC.
- Forces `WHISPER_BUILD_TESTS=OFF`, `WHISPER_BUILD_EXAMPLES=OFF`,
  `WHISPER_BUILD_SERVER=OFF` to suppress upstream's other targets.
- Forces `BUILD_SHARED_LIBS=OFF` so whisper + ggml link as static libs into
  our addon `.node` file (otherwise we'd need to ship `.dylib`/`.so` files).
- On macOS: enables `GGML_METAL` and `GGML_METAL_EMBED_LIBRARY` for free
  Apple Silicon GPU acceleration, with no Metal API surface in our code.
- `add_subdirectory(vendor/whisper.cpp)` pulls in the upstream's own
  CMakeLists, which transitively builds `ggml`, `ggml-cpu`, `ggml-metal`
  (on macOS), and `whisper`.
- Adds the addon target, links `whisper`, includes node-addon-api headers
  found via `node -p "require('node-addon-api').include"`.

`cmake-js` injects `${CMAKE_JS_INC}`, `${CMAKE_JS_SRC}`, and `${CMAKE_JS_LIB}`
which point at Node's headers and the import library. The output is
`build/Release/whisper_addon.node`.

### Common build failures

- **`cmake: command not found`** — install cmake (`brew install cmake`).
- **`File vendor/whisper.cpp/cmake/whisper-config.cmake.in does not exist`** —
  the vendoring script forgot to copy `cmake/`. Re-run it (the script was
  fixed during initial implementation; older clones may need a re-vendor).
- **C++ standard errors** — Apple clang ≥ 14 / gcc ≥ 11 required for C++17.
- **Metal/Foundation errors on macOS** — Xcode CLT not installed
  (`xcode-select --install`).

## 7. The handle cache in transcribe.ts

`handleCache: Record<string, { instance: WhisperModelInstance }>` keyed by
absolute model path. The first call to `transcribe(model)` constructs a
`new WhisperModel(modelPath)` (which loads the weights — slow); subsequent
calls reuse the cached instance.

The cache is an **LRU with a default cap of 2 entries**. When the cap is
exceeded, the least-recently-used entry is evicted and `instance.free()` is
called on it. Override the cap via `AGENCY_WHISPER_HANDLE_CACHE_MAX`
(set to `0` to disable caching entirely — every `transcribe()` loads + frees).

**Why a cap?** A `large-v3` whisper context is ~3 GB; an unbounded cache
in a long-running web server that switches models on user input is a
straightforward OOM vector.

**Why default 2?** Most Agency programs use one model. Two leaves headroom
for "switch from base.en to large-v3 mid-program" without thrashing.

**Implications:**
- A long-running process holds at most `cap` model contexts in memory at
  any time. Use `_clearHandleCache()` (exported for tests and explicit
  teardown) to reclaim everything.
- LRU promotion is implemented as `delete + reinsert`, which is O(1) on
  V8's hash map and preserves insertion order for `Object.keys()`.
- Eviction respects the in-flight counter: if `free()` throws "WhisperModel
  busy" we log a warning and drop the cache entry; the C++ Persistent ref
  keeps the model alive until the worker thread finishes, then JS GC
  reclaims it.
- Concurrent `transcribe()` calls on the same model serialize via the
  per-context mutex in C++ (see §3). Callers who want true concurrency
  should use multiple distinct model paths (each on its own libuv worker
  thread) — see the README's "Operational notes" for `UV_THREADPOOL_SIZE`.
- The cache uses `Record` (not `Map`) per the project convention from
  `AGENTS.md` ("Use objects instead of maps").

## 7a. ffmpeg pipeline hardening (`ffmpeg.ts`)

The decode step shells out to ffmpeg. Several hardening guards exist
because `transcribe(filepath)` is commonly called with an LLM-driven tool
argument in Agency programs — i.e. attacker-influenceable input.

- **Protocol whitelist.** `buildFfmpegArgs` includes
  `-protocol_whitelist file` so ffmpeg refuses any non-`file:` URL. Without
  this, a `filepath` of `http://evil/x` would make ffmpeg perform an
  outbound HTTP request (SSRF), and `concat:` / `subfile:` could read
  arbitrary local files via ffmpeg's input demuxers.
- **Path validation.** `decodeToPcm` rejects any `filepath` starting with
  `-` (defense in depth against argument-position confusion if the command
  line is ever reordered) and `fs.stat`'s the path to confirm it is a
  regular file before spawning. Directories, FIFOs, devices, and missing
  files are rejected with a clear error.
- **Timeout.** Each invocation has a 10-minute wall clock cap (override via
  `decodeToPcm({ timeoutMs })`). On expiry the child is `SIGKILL`-ed
  (intentionally not `SIGTERM`: a stuck ffmpeg may ignore TERM, and we'd
  rather strand a partial decode than hold a worker forever). The kill
  handler synthesizes a tagged rejection so the caller sees a clear
  "exceeded timeout of N ms" message rather than a generic "exit code null".
- **Decoded-output cap.** A running byte counter on stdout kills ffmpeg if
  the decoded PCM exceeds 2 GB (override via `decodeToPcm({ maxPcmBytes })`).
  This is mid-stream — we don't accumulate the whole buffer first and then
  check. ffmpeg has no way to know our cap, so the producer keeps writing
  until kill() lands; in the steady state the over-cap window is bounded
  by one stdout chunk (typically tens of KB).
- **Float32 assembly.** After successful decode, we wrap the bytes as
  `Float32Array` via a one-shot `Uint8Array.set(buf)` into a freshly
  allocated `ArrayBuffer`, rather than `for (i...) buf.readFloatLE(i*4)`.
  The loop form is ~100× slower on long audio. The freshly allocated
  buffer is guaranteed 4-byte aligned (Float32Array requires it) and
  byte-equal to ffmpeg's output (Node only ships on little-endian hosts;
  ffmpeg's `f32le` output is also little-endian).

## 8. The Agency wrapper conventions

`index.agency` is a one-line passthrough wrapper around `transcribeImpl`
from `dist/src/transcribe.js`. The Agency-side type signature, default
values, and docstring all live in `index.agency`; the actual logic lives
in TypeScript.

**No `interrupt`** in the wrapper. Transcription is purely local and
fast (typically a few seconds, even for large files), so we don't need a
human-in-the-loop gate. If a user wants cancellation, they can wrap the
call themselves with their own interrupt logic.

**The `pkg::` import** (`import { transcribe } from
"pkg::@agency-lang/whisper-local"`) is resolved by agency-lang's
[`importPaths.ts`](../../agency-lang/lib/importPaths.ts) which reads the
`"agency"` field from `package.json` (set to `./index.agency`).

## 9. The testing pyramid

| Test file | Layer | What it covers |
|-----------|-------|----------------|
| `tests/modelManager.test.ts` | Pure JS | Path resolution, lockfile parsing, SHA computation, download with hash verification, atomic rename, HTTPS-only enforcement, partial cleanup |
| `tests/ffmpeg.test.ts` | Pure JS | Argument construction, Float32Array decoding from stdout, error paths (ENOENT, non-zero exit). Mocks `child_process.spawn`. |
| `tests/transcribe.test.ts` | Orchestration | Joins segments, forwards arguments, caches handles, rejects empty filepath. Mocks the addon, modelManager, and ffmpeg. |
| `tests/integration.test.ts` | End-to-end | Real model download, real ffmpeg decode, real native addon transcription. Gated `AGENCY_RUN_SLOW=1`. Uses `tests/fixtures/hello.wav`. |

**What is intentionally NOT tested:**
- The C++ addon directly (no C++ test harness; covered by integration
  test instead).
- The agency-js wrapper via a stub-injection harness — the project doesn't
  have one, and the wrapper is a one-line passthrough. See
  `tests/agency-js/README.md`.
- Concurrent transcribe calls on the same model — would need a stress
  test, and the mutex behavior is correct by construction.

## 10. The CI workflow

`.github/workflows/whisper-local.yml` runs only when files under
`packages/whisper-local/**` or the workflow itself change (path filter).
This is a deliberate split from the main `test.yml`:

- The native build adds 60-90 seconds; the integration test downloads
  ~75 MB and adds 15+ seconds. Running both on every unrelated PR would
  significantly slow CI.
- The path filter means a typo fix in agency-lang's docs doesn't trigger
  a whisper-local build.

The workflow installs `cmake build-essential ffmpeg` via apt on the
`ubuntu-latest` runner, runs `pnpm install` (which does NOT trigger any
native build because there's no install hook), then explicitly runs
`node dist/src/cli.js build` — exactly what the user runs after
installation.

**If the integration test fails in CI**, it's almost always a model
download failure (HuggingFace temporary 5xx, IP rate limit). Re-running
the workflow usually fixes it. If it persists, check whether HuggingFace
moved the file at the pinned commit (shouldn't be possible if the URL is
truly content-addressed by SHA, but worth confirming).

## 11. Lessons learned / gotchas

Surfaced during initial implementation:

- **The `cmake/` directory at the upstream root is required by
  `vendor/whisper.cpp/CMakeLists.txt`** — initial vendoring skipped it
  (only copied `src/`, `include/`, `ggml/`) and CMake configuration failed
  with `cmake/whisper-config.cmake.in does not exist`. The vendoring
  script now explicitly copies `cmake/` too.

- **`BUILD_SHARED_LIBS=OFF` is necessary.** Without it, whisper builds as a
  shared library and you have to ship the `.dylib`/`.so`. We force static.

- **`Float32Array.ElementLength()` is the float count, not bytes.** Using
  `ByteLength()` would have over-read PCM data by 4×.

- **`Napi::ObjectReference` is the right tool to keep a JS object alive
  across an async boundary.** Earlier sketches used a raw pointer with
  `model.free()` discipline, but JS GC could still collect the model and
  destruct the wrapper before the worker finished. Persistent ref is the
  fix.

- **`SetError` not `throw` in `Napi::AsyncWorker::Execute()`.** The latter
  is undefined off the JS thread.

- **macOS `say` does NOT produce a standard WAV.** It emits AIFF
  regardless of the file extension. Earlier draft of the integration test
  tried `say -o hello.wav "..."` then `ffmpeg` to convert, which is
  fragile. We just use the existing `packages/agency-lang/hello.wav`
  (real recorded WAV) instead.

- **Brace expansion (`rm -rf foo/{a,b,c}`) is not POSIX.** The cleanup
  steps in CI and Task 16 use three explicit `rm` commands instead.

- **The agency-lang test harness for `tests/agency-js/` compiles and runs
  `.agency` files via the agency CLI; there is no `runAgency`-style mock
  injection harness.** The plan's sketch was hypothetical. The wrapper is
  a one-liner so the existing JS tests fully cover its behavior.

- **`pnpm install` succeeds quickly even on systems without cmake/ffmpeg**
  because we have no install hook. This is the security feature of "no
  postinstall" working as designed.
