# Local Whisper Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@agency-lang/whisper-local`, a new Agency package that transcribes audio entirely on the user's machine via a custom N-API binding to vendored whisper.cpp.

**Architecture:** Three layers — (1) a small N-API C++ addon (`src/addon.cc`) wrapping six whisper.cpp functions; (2) a pure-JS orchestration layer (`transcribe.ts`, `modelManager.ts`, `ffmpeg.ts`) that resolves model paths, downloads models with SHA-256 verification, shells out to `ffmpeg` for audio decoding, and calls the addon; (3) a thin `.agency` wrapper mirroring the stdlib `transcribe()` signature with no interrupt gate. whisper.cpp source is vendored (no submodule, no install-time network). Source-build only for v0 via `cmake-js`; prebuilts are a follow-up.

**Security posture (no postinstall):** This package does NOT run any postinstall, install, or prepare script. `npm install @agency-lang/whisper-local` only copies files to disk — it does not invoke a compiler, fetch network resources, or execute vendored code. The user must run `npx agency-whisper build` once after install to compile the native addon. This is an explicit, opt-in, auditable step. Rationale: (a) postinstall scripts are the most common npm supply-chain attack vector, and many CI environments and security-conscious users run `pnpm install --ignore-scripts` by default; (b) silently invoking `cmake` and the vendored C++ source on `npm install` would surprise users who pulled the package as a transitive dep but never intended to use it; (c) build failures (missing cmake / ffmpeg / Xcode CLT) on install would break unrelated `pnpm install` runs in the monorepo and CI. The trust model is: the user explicitly chose to install AND chose to run `agency-whisper build`. Both decisions are visible in the user's shell history and CI logs.

**Tech Stack:** TypeScript, C++17, `node-addon-api` (N-API), `cmake-js`, `vitest`, vendored whisper.cpp (MIT), externally-installed `ffmpeg` (spawned, not linked).

**Spec:** [`docs/superpowers/specs/2026-05-11-whisper-local-design.md`](../specs/2026-05-11-whisper-local-design.md)

**Critical context for the implementer:**
- All paths below are rooted at `packages/whisper-local/` unless otherwise noted. The package sits alongside `packages/brave-search/` in the monorepo.
- Use `pnpm test:run path/to/file.test.ts` to run a specific vitest file once. Never leave vitest in watch mode. Save expensive test output to a file: `pnpm test:run tests/integration.test.ts > /tmp/whisper-integration.log 2>&1`.
- The codebase uses `type` not `interface`, objects not maps, arrays not sets. Never use dynamic imports.
- Commit frequently. Never force-push, never `--amend`.
- Apostrophes in commit messages from the CLI break — write commit messages to a file and pass via `git commit -F`.
- macOS 14+ assumed for local dev. The implementer is on macOS; Linux is tested via CI only.
- Pre-flight check the implementer should run before starting: `cmake --version` (need ≥3.18), `c++ --version` (need C++17), `ffmpeg -version`. If any are missing the README will eventually document install commands; for development, install them first.
- The brave-search package (`packages/brave-search/`) is a useful structural reference for `package.json`, `tsconfig.json`, `makefile`, and the `index.agency` + `index.js` layout. Read it before Task 1.

---

## File Structure

**Will create (all paths rooted at `packages/whisper-local/`):**
- `package.json` — npm manifest, bin entries. **No** install/postinstall/prepare scripts.
- `makefile` — `make` builds .ts → .js and runs cmake-js (developer convenience only — not run by `npm install`).
- `tsconfig.json` — same shape as brave-search.
- `.gitignore` — ignores `build/`, `dist/`, `node_modules/`.
- `CMakeLists.txt` — cmake-js entry: builds whisper.cpp + ggml static libs, links addon.
- `cmake-js.config.cjs` — cmake-js options (optional; can inline in package.json).
- `README.md` — install, quick start, model table, manual placement, troubleshooting, **Credits**.
- `index.agency` — public Agency API.
- `models.lock.json` — `{ name, url, sha256, sizeBytes }` per model.
- `src/addon.cc` — N-API binding (~300 LOC).
- `src/transcribe.ts` — high-level orchestration.
- `src/modelManager.ts` — path resolution, download, SHA-256.
- `src/ffmpeg.ts` — spawn ffmpeg, capture PCM, error if missing.
- `src/cli.ts` — `pull`, `list`, `verify` subcommands.
- `src/types.ts` — shared types (`ModelName`, `LockfileEntry`).
- `tests/modelManager.test.ts`
- `tests/ffmpeg.test.ts`
- `tests/transcribe.test.ts`
- `tests/integration.test.ts` — gated `AGENCY_RUN_SLOW=1`.
- `tests/agency-js/transcribe.test.ts` — stub-JS-module test through the .agency wrapper.
- `tests/fixtures/hello.wav` — 5-second public-domain sample.
- `vendor/whisper.cpp/` — vendored source (`src/`, `include/`, `ggml/src/`, `ggml/include/`, plus `LICENSE`).
- `vendor/whisper.cpp/VERSION` — text file, one line, e.g. `v1.7.6`.
- `vendor/whisper.cpp/UPSTREAM_SHA256` — text file, expected SHA-256 of the upstream tarball.

**Will modify (root monorepo):**
- `pnpm-workspace.yaml` — already globs `packages/*`, so no change needed. Verify in Task 1.

---

## Task 1: Scaffold the package skeleton

**Files:**
- Create: `packages/whisper-local/package.json`
- Create: `packages/whisper-local/tsconfig.json`
- Create: `packages/whisper-local/makefile`
- Create: `packages/whisper-local/.gitignore`
- Create: `packages/whisper-local/src/types.ts`
- Create: `packages/whisper-local/README.md` (skeleton; full content in Task 15)

- [ ] **Step 1: Create the package directory**

Run: `mkdir -p packages/whisper-local/src packages/whisper-local/tests/fixtures packages/whisper-local/tests/agency-js packages/whisper-local/vendor`

- [ ] **Step 2: Write `package.json`**

Content for `packages/whisper-local/package.json`:

```json
{
  "name": "@agency-lang/whisper-local",
  "version": "0.0.1",
  "description": "Local Whisper transcription for Agency using vendored whisper.cpp",
  "type": "module",
  "agency": "./index.agency",
  "main": "./dist/src/transcribe.js",
  "bin": {
    "agency-whisper": "./dist/src/cli.js"
  },
  "exports": {
    ".": {
      "types": "./dist/src/transcribe.d.ts",
      "import": "./dist/src/transcribe.js"
    },
    "./package.json": "./package.json"
  },
  "files": [
    "dist/",
    "build/Release/whisper_addon.node",
    "vendor/",
    "CMakeLists.txt",
    "index.agency",
    "index.js",
    "models.lock.json",
    "README.md"
  ],
  "scripts": {
    "build:ts": "tsc",
    "build:native": "cmake-js compile --runtime=node",
    "build": "pnpm run build:native && pnpm run build:ts",
    "test": "vitest",
    "test:run": "vitest run",
    "test:agency": "agency tests/agency"
  },
  "peerDependencies": {
    "agency-lang": "workspace:*"
  },
  "dependencies": {
    "cmake-js": "^7.3.0",
    "node-addon-api": "^8.0.0"
  },
  "devDependencies": {
    "@types/node": "^25.0.6",
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  },
  "author": "Aditya Bhargava",
  "license": "ISC",
  "bugs": { "url": "https://github.com/egonSchiele/agency-lang/issues" },
  "homepage": "https://github.com/egonSchiele/agency-lang"
}
```

Notes for the implementer:
- **No `install`, `postinstall`, or `prepare` script.** See the "Security posture" section in the plan header. The native addon is built only when the user explicitly runs `npx agency-whisper build` (added in Task 12). This means `pnpm install` for this package never invokes `cmake`, never executes vendored C++ code, and never fails on machines without build tools.
- `files` includes `vendor/` because that's where whisper.cpp source lives and whisper.cpp's LICENSE must ship with the package. Users who run `agency-whisper build` need the vendored source on disk.
- `cmake-js` and `node-addon-api` are listed in `dependencies` (not devDependencies) because the user-invoked `agency-whisper build` step needs them after install. They are NOT executed at install time.

- [ ] **Step 3: Write `tsconfig.json`** — copy `packages/brave-search/tsconfig.json` verbatim (already correct for this package).

- [ ] **Step 4: Write `makefile`**

```make
all: build

build:
	pnpm run build

clean:
	rm -rf build dist

publish:
	pnpm publish --access public --no-git-checks
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
dist/
build/
*.tsbuildinfo
~/.cache/
```

- [ ] **Step 6: Write `src/types.ts`** (placeholder; populated in Task 6)

```ts
export type ModelName =
  | "tiny" | "tiny.en"
  | "base" | "base.en"
  | "small" | "small.en"
  | "medium" | "medium.en"
  | "large-v3" | "large-v3-turbo";

export type LockfileEntry = {
  url: string;
  sha256: string;
  sizeBytes: number;
};

export type Lockfile = {
  schemaVersion: 1;
  models: Record<ModelName, LockfileEntry>;
};
```

- [ ] **Step 7: Write `README.md` skeleton**

```markdown
# @agency-lang/whisper-local

Local Whisper transcription for Agency. No network at runtime, no API key.

Full documentation: see Task 15 — this is a placeholder.
```

- [ ] **Step 8: Verify workspace picks up the package**

Run from repo root: `pnpm install`. Expected: succeeds (no native build runs because we deliberately do not register an install script), lists `@agency-lang/whisper-local` in the workspace.

Save output: `pnpm install > /tmp/whisper-install-step1.log 2>&1`

- [ ] **Step 9: Commit**

```bash
cd /Users/adit/agency-lang
git add packages/whisper-local
git commit -m "$(cat <<'EOF'
Scaffold @agency-lang/whisper-local package

Empty skeleton: package.json, tsconfig, makefile, types, README placeholder.
No native build or source yet. No install/postinstall hooks (security: see
plan header). Verifies the package is discovered by the workspace via
plain pnpm install.
EOF
)"
```

---

## Task 2: Vendor whisper.cpp

**Files:**
- Create: `packages/whisper-local/vendor/whisper.cpp/VERSION`
- Create: `packages/whisper-local/vendor/whisper.cpp/UPSTREAM_SHA256`
- Create: `packages/whisper-local/vendor/whisper.cpp/LICENSE`
- Create: `packages/whisper-local/vendor/whisper.cpp/src/...` (copied tree)
- Create: `packages/whisper-local/vendor/whisper.cpp/include/...`
- Create: `packages/whisper-local/vendor/whisper.cpp/ggml/src/...`
- Create: `packages/whisper-local/vendor/whisper.cpp/ggml/include/...`
- Create: `packages/whisper-local/scripts/vendor-whisper.sh`

- [ ] **Step 1: Write the vendoring script**

`packages/whisper-local/scripts/vendor-whisper.sh`:

```bash
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
mkdir -p "$VENDOR_DIR/src" "$VENDOR_DIR/include" "$VENDOR_DIR/ggml/src" "$VENDOR_DIR/ggml/include"

cp -R "$SRC/src/"*       "$VENDOR_DIR/src/"
cp -R "$SRC/include/"*   "$VENDOR_DIR/include/"
cp -R "$SRC/ggml/src/"*  "$VENDOR_DIR/ggml/src/"
cp -R "$SRC/ggml/include/"* "$VENDOR_DIR/ggml/include/"
cp "$SRC/LICENSE"        "$VENDOR_DIR/LICENSE"

echo "$TAG"    > "$VENDOR_DIR/VERSION"
echo "$ACTUAL" > "$VENDOR_DIR/UPSTREAM_SHA256"

echo "Done. Inspect $VENDOR_DIR, then commit."
```

Make executable: `chmod +x packages/whisper-local/scripts/vendor-whisper.sh`

- [ ] **Step 2: Run the vendoring script with the chosen tag**

Pick the latest stable tag at implementation time (this plan assumes `v1.7.6` but bump as needed). Run:

```bash
bash packages/whisper-local/scripts/vendor-whisper.sh v1.7.6
```

Expected: prints the SHA-256, populates `vendor/whisper.cpp/`. Inspect the output:
- `vendor/whisper.cpp/LICENSE` should be the MIT license, copyright Georgi Gerganov.
- `vendor/whisper.cpp/VERSION` should be `v1.7.6`.
- `vendor/whisper.cpp/UPSTREAM_SHA256` should be the 64-char hex of the tarball.
- `vendor/whisper.cpp/src/whisper.cpp` should exist (the main implementation file).
- `vendor/whisper.cpp/include/whisper.h` should exist.
- `vendor/whisper.cpp/ggml/include/ggml.h` should exist.

**Verify the SHA-256 manually** against an independent source — the GitHub release page or a separate `curl` from a different network. This is the moment to catch tarball tampering; we'll trust this hash forever after.

- [ ] **Step 3: Per-file copyright headers verification**

Run: `grep -l "Copyright" packages/whisper-local/vendor/whisper.cpp/src/whisper.cpp packages/whisper-local/vendor/whisper.cpp/include/whisper.h`

Expected: the copyright notices in whisper.cpp's source files are preserved (they will be, because we copied verbatim). The check is just a sanity confirmation.

- [ ] **Step 4: Commit**

```bash
git add packages/whisper-local/vendor packages/whisper-local/scripts
git commit -m "$(cat <<'EOF'
Vendor whisper.cpp v1.7.6 into whisper-local

MIT-licensed source tree copied verbatim from the upstream tag. LICENSE
preserved at vendor/whisper.cpp/LICENSE. SHA-256 of the upstream tarball
recorded for future verification. Bump procedure documented in
scripts/vendor-whisper.sh.
EOF
)"
```

---

## Task 3: CMakeLists.txt + addon stub builds

**Files:**
- Create: `packages/whisper-local/CMakeLists.txt`
- Create: `packages/whisper-local/src/addon.cc` (stub for now)

This task verifies the build chain (cmake-js → cmake → C++ compiler → vendored whisper.cpp → .node addon) works end-to-end before we write any real binding code.

- [ ] **Step 1: Write `CMakeLists.txt`**

```cmake
cmake_minimum_required(VERSION 3.18)
project(whisper_addon)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# --- whisper.cpp + ggml as static libs ---
set(WHISPER_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(GGML_METAL OFF CACHE BOOL "" FORCE)
set(GGML_BLAS  OFF CACHE BOOL "" FORCE)

# macOS: enable Metal acceleration (free, no API surface needed)
if(APPLE)
  set(GGML_METAL ON CACHE BOOL "" FORCE)
  set(GGML_METAL_EMBED_LIBRARY ON CACHE BOOL "" FORCE)
endif()

add_subdirectory(vendor/whisper.cpp/ggml)
add_subdirectory(vendor/whisper.cpp/src)
target_include_directories(whisper PUBLIC vendor/whisper.cpp/include)

# --- N-API addon ---
include_directories(${CMAKE_JS_INC})

file(GLOB ADDON_SOURCES "src/addon.cc")
add_library(${PROJECT_NAME} SHARED ${ADDON_SOURCES} ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")

target_link_libraries(${PROJECT_NAME} PRIVATE whisper ggml ${CMAKE_JS_LIB})

# node-addon-api
execute_process(
  COMMAND node -p "require('node-addon-api').include"
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(REGEX REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
target_include_directories(${PROJECT_NAME} PRIVATE ${NODE_ADDON_API_DIR})
add_definitions(-DNAPI_VERSION=8)
```

Note: whisper.cpp's `src/CMakeLists.txt` and `ggml/CMakeLists.txt` ship from upstream and define the `whisper` and `ggml` targets. The `WHISPER_BUILD_*` flags suppress upstream's tests/examples; the `GGML_METAL` flag enables Metal on macOS.

- [ ] **Step 2: Write `src/addon.cc` stub**

```cpp
#include <napi.h>

Napi::String Hello(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), "whisper-local addon loaded");
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("hello", Napi::Function::New(env, Hello));
  return exports;
}

NODE_API_MODULE(whisper_addon, Init)
```

- [ ] **Step 3: Build it**

From the package directory:

```bash
cd packages/whisper-local
pnpm install        # installs cmake-js + node-addon-api (no native build runs — no install hook)
pnpm run build:native
```

Expected: cmake configures, builds ggml + whisper + the addon. Output: `build/Release/whisper_addon.node`. Save build log: `pnpm run build:native > /tmp/whisper-build-step3.log 2>&1`.

On failure, common causes:
- `cmake: command not found` → install cmake (`brew install cmake`).
- C++ standard errors → check `c++ --version` is at least Apple clang 14 / gcc 11.
- Metal/Foundation errors on macOS → xcode CLT not installed (`xcode-select --install`).

- [ ] **Step 4: Smoke-test the addon loads in Node**

Run:
```bash
node -e "console.log(require('./build/Release/whisper_addon.node').hello())"
```
Expected output: `whisper-local addon loaded`

- [ ] **Step 5: Commit**

```bash
git add packages/whisper-local/CMakeLists.txt packages/whisper-local/src/addon.cc
git commit -m "$(cat <<'EOF'
Wire up cmake-js build for whisper-local addon

Builds vendored whisper.cpp + ggml as static libs, links a stub N-API
addon. Metal enabled on macOS. Stub exports hello() to confirm the
addon loads in Node. Real bindings land in subsequent tasks.
EOF
)"
```

---

## Task 4: N-API binding — model load / free

**Files:**
- Modify: `packages/whisper-local/src/addon.cc`

This task adds `loadModel(path) → modelHandle` and `freeModel(handle)` and confirms whisper.cpp can load a `.bin` file we drop in by hand.

- [ ] **Step 1: Write the binding code**

Replace `src/addon.cc` with:

```cpp
#include <napi.h>
#include <whisper.h>
#include <memory>

class WhisperModel : public Napi::ObjectWrap<WhisperModel> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  WhisperModel(const Napi::CallbackInfo& info);
  ~WhisperModel();

  whisper_context* ctx() { return ctx_; }

private:
  whisper_context* ctx_ = nullptr;

  Napi::Value Free(const Napi::CallbackInfo& info);
};

WhisperModel::WhisperModel(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<WhisperModel>(info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "loadModel(path: string) requires a string path")
        .ThrowAsJavaScriptException();
    return;
  }

  std::string path = info[0].As<Napi::String>().Utf8Value();
  whisper_context_params params = whisper_context_default_params();
  // params.use_gpu is true by default; whisper.cpp falls back to CPU if no GPU.

  ctx_ = whisper_init_from_file_with_params(path.c_str(), params);
  if (ctx_ == nullptr) {
    Napi::Error::New(env, "whisper_init_from_file_with_params failed for: " + path)
        .ThrowAsJavaScriptException();
  }
}

WhisperModel::~WhisperModel() {
  if (ctx_ != nullptr) {
    whisper_free(ctx_);
    ctx_ = nullptr;
  }
}

Napi::Value WhisperModel::Free(const Napi::CallbackInfo& info) {
  if (ctx_ != nullptr) {
    whisper_free(ctx_);
    ctx_ = nullptr;
  }
  return info.Env().Undefined();
}

Napi::Object WhisperModel::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(env, "WhisperModel", {
    InstanceMethod("free", &WhisperModel::Free),
  });
  exports.Set("WhisperModel", func);
  return exports;
}

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  WhisperModel::Init(env, exports);
  return exports;
}

NODE_API_MODULE(whisper_addon, InitAll)
```

- [ ] **Step 2: Rebuild**

```bash
pnpm run build:native > /tmp/whisper-build-step4.log 2>&1
```
Expected: success.

- [ ] **Step 3: Manual smoke test**

The implementer downloads `ggml-tiny.en.bin` (~75 MB) manually for testing:

```bash
mkdir -p ~/.agency/models/whisper
curl -L -o ~/.agency/models/whisper/ggml-tiny.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin
```

Then verify the addon can load it:

```bash
node -e "
const { WhisperModel } = require('./build/Release/whisper_addon.node');
const m = new WhisperModel(require('path').join(require('os').homedir(), '.agency/models/whisper/ggml-tiny.en.bin'));
console.log('loaded OK');
m.free();
console.log('freed OK');
"
```
Expected output:
```
loaded OK
freed OK
```

Failure modes:
- "whisper_init_from_file_with_params failed" → the .bin file is corrupted or not a whisper.cpp ggml model.

- [ ] **Step 4: Commit**

```bash
git add packages/whisper-local/src/addon.cc
git commit -m "Add WhisperModel class binding for load/free in addon"
```

---

## Task 5: N-API binding — transcribe

**Files:**
- Modify: `packages/whisper-local/src/addon.cc`

Adds the actual transcription method. Uses `Napi::AsyncWorker` so a long inference doesn't block the event loop.

**Memory-safety design (CRITICAL — read before writing the code):**

The naive `TranscribeWorker { whisper_context* ctx_; ... }` design has three latent bugs:

1. **Use-after-free via JS GC.** If JS drops its last reference to the `WhisperModel` while a worker is in flight, `~WhisperModel` runs on the JS thread and calls `whisper_free(ctx_)`. The background worker, still executing on a libuv thread, then dereferences a freed `whisper_context*` and segfaults (or worse, corrupts heap memory).

2. **Use-after-free via explicit `free()`.** Same scenario, but user code calls `model.free()` between starting and awaiting `transcribe()`.

3. **Data race on concurrent calls.** `whisper_full` mutates the `whisper_context`; running two `whisper_full` calls on the same context concurrently is undefined behavior. The handle cache in `transcribe.ts` deliberately reuses one model across calls, so this can happen if a user fires off two `transcribe()` calls without awaiting.

**Fixes baked into the code below:**

- **Persistent reference.** `TranscribeWorker` holds a `Napi::ObjectReference` to its parent `WhisperModel`. The reference is created via `Napi::Persistent(info.This())` and the count is incremented before `Queue()`. This pins the JS object alive until `OnOK`/`OnError` runs (which `delete`s the worker, dropping the ref). GC cannot collect the model while a worker is queued.
- **Explicit-free is rejected when busy.** `Free()` and `~WhisperModel` check an atomic `inflight_` counter; if non-zero, `Free()` throws `"WhisperModel busy: free() called while transcribe() is in flight"`. The destructor (only reachable when no JS references exist, which is now guaranteed not to happen during in-flight work because of the Persistent ref) is a safety net only.
- **Per-context mutex.** `WhisperModel` owns a `std::mutex mu_`. `TranscribeWorker::Execute()` locks it. Two concurrent `transcribe()` calls on the same model serialize cleanly instead of racing.
- **Read `ctx_` once, under the mutex.** The worker re-reads `model_->ctx_` inside `Execute()` while holding the mutex. If `Free()` somehow ran (it shouldn't, given the persistent ref, but defense in depth), the worker sees `nullptr` and calls `SetError` instead of crashing.
- **`std::vector<float>` for PCM.** We copy the Float32Array contents into a heap vector before queuing. The JS-managed buffer can be GC'd safely after `Transcribe` returns.
- **`std::string` for `language`.** Stored as a member; `c_str()` is read inside `Execute()` and lives as long as the worker.
- **Bounds-checked typed-array conversion.** The vector is constructed from `[Data(), Data() + ElementLength())`. `ElementLength()` is the count of `float`s, not bytes — using `ByteLength()` here would over-read by 4×.
- **`SetError` not `throw`.** `Napi::AsyncWorker::Execute()` runs off the JS thread; throwing C++ exceptions there is undefined. Use `SetError(std::string)` which `OnError` translates into a JS rejection.

These fixes add ~30 lines of code but eliminate the entire "addon segfaults if user holds it wrong" failure mode.

- [ ] **Step 1: Add the transcribe worker and method**

Add includes and the worker class. Append to `src/addon.cc` (insert before `WhisperModel::Init`):

```cpp
#include <atomic>
#include <mutex>
#include <vector>

class WhisperModel; // forward

class TranscribeWorker : public Napi::AsyncWorker {
public:
  TranscribeWorker(Napi::Env env,
                   Napi::Promise::Deferred deferred,
                   Napi::ObjectReference modelRef,
                   WhisperModel* model,
                   std::vector<float> pcm,
                   std::string language,
                   bool translate);

  ~TranscribeWorker() override;

  void Execute() override;
  void OnOK() override;
  void OnError(const Napi::Error& err) override;

private:
  Napi::Promise::Deferred deferred_;
  Napi::ObjectReference modelRef_; // pins the WhisperModel alive across the async boundary
  WhisperModel* model_;
  std::vector<float> pcm_;
  std::string language_;
  bool translate_;
  std::vector<std::string> segments_;
};
```

Update `WhisperModel`'s declaration to add the mutex, in-flight counter, and friendship:

```cpp
class WhisperModel : public Napi::ObjectWrap<WhisperModel> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  WhisperModel(const Napi::CallbackInfo& info);
  ~WhisperModel();

  whisper_context* ctx() { return ctx_; }
  std::mutex& mutex() { return mu_; }
  void incInflight() { inflight_.fetch_add(1, std::memory_order_acq_rel); }
  void decInflight() { inflight_.fetch_sub(1, std::memory_order_acq_rel); }

private:
  whisper_context* ctx_ = nullptr;
  std::mutex mu_;
  std::atomic<int> inflight_{0};

  Napi::Value Free(const Napi::CallbackInfo& info);
  Napi::Value Transcribe(const Napi::CallbackInfo& info);
};
```

Update `Free` to refuse when busy:

```cpp
Napi::Value WhisperModel::Free(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (inflight_.load(std::memory_order_acquire) != 0) {
    Napi::Error::New(env,
        "WhisperModel busy: free() called while transcribe() is in flight. "
        "Await all pending transcribe() promises before calling free().")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::lock_guard<std::mutex> lock(mu_);
  if (ctx_ != nullptr) {
    whisper_free(ctx_);
    ctx_ = nullptr;
  }
  return env.Undefined();
}
```

Worker constructor / destructor / methods:

```cpp
TranscribeWorker::TranscribeWorker(Napi::Env env,
                                   Napi::Promise::Deferred deferred,
                                   Napi::ObjectReference modelRef,
                                   WhisperModel* model,
                                   std::vector<float> pcm,
                                   std::string language,
                                   bool translate)
    : Napi::AsyncWorker(env),
      deferred_(deferred),
      modelRef_(std::move(modelRef)),
      model_(model),
      pcm_(std::move(pcm)),
      language_(std::move(language)),
      translate_(translate) {
  model_->incInflight();
}

TranscribeWorker::~TranscribeWorker() {
  model_->decInflight();
  // modelRef_ is reset by ObjectReference's destructor on the JS thread.
}

void TranscribeWorker::Execute() {
  std::lock_guard<std::mutex> lock(model_->mutex());
  whisper_context* ctx = model_->ctx();
  if (ctx == nullptr) {
    SetError("WhisperModel was freed before transcribe could run");
    return;
  }

  whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  params.print_progress  = false;
  params.print_realtime  = false;
  params.print_timestamps = false;
  params.print_special   = false;
  params.translate       = translate_;
  params.language        = language_.empty() ? "auto" : language_.c_str();

  int rc = whisper_full(ctx, params, pcm_.data(), static_cast<int>(pcm_.size()));
  if (rc != 0) {
    SetError("whisper_full returned non-zero status " + std::to_string(rc));
    return;
  }

  int n = whisper_full_n_segments(ctx);
  segments_.reserve(static_cast<size_t>(n));
  for (int i = 0; i < n; ++i) {
    const char* text = whisper_full_get_segment_text(ctx, i);
    if (text != nullptr) {
      segments_.emplace_back(text); // copies into std::string
    }
  }
}

void TranscribeWorker::OnOK() {
  Napi::Env env = Env();
  Napi::HandleScope scope(env);
  Napi::Array arr = Napi::Array::New(env, segments_.size());
  for (size_t i = 0; i < segments_.size(); ++i) {
    arr.Set(static_cast<uint32_t>(i), Napi::String::New(env, segments_[i]));
  }
  deferred_.Resolve(arr);
}

void TranscribeWorker::OnError(const Napi::Error& err) {
  deferred_.Reject(err.Value());
}
```

`Transcribe` method:

```cpp
Napi::Value WhisperModel::Transcribe(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::HandleScope scope(env);

  if (ctx_ == nullptr) {
    Napi::Error::New(env, "WhisperModel has been freed").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsTypedArray()) {
    Napi::TypeError::New(env, "transcribe(pcm: Float32Array, opts?) requires a Float32Array")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::TypedArray ta = info[0].As<Napi::TypedArray>();
  if (ta.TypedArrayType() != napi_float32_array) {
    Napi::TypeError::New(env, "pcm must be a Float32Array").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Float32Array f32 = ta.As<Napi::Float32Array>();
  // ElementLength is float count; copy [Data(), Data()+ElementLength()) — NOT ByteLength!
  const float* src = f32.Data();
  const size_t n = f32.ElementLength();
  std::vector<float> pcm(src, src + n);

  std::string language;
  bool translate = false;
  if (info.Length() >= 2 && info[1].IsObject()) {
    Napi::Object opts = info[1].As<Napi::Object>();
    if (opts.Has("language") && opts.Get("language").IsString()) {
      language = opts.Get("language").As<Napi::String>().Utf8Value();
    }
    if (opts.Has("translate") && opts.Get("translate").IsBoolean()) {
      translate = opts.Get("translate").As<Napi::Boolean>().Value();
    }
  }

  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);

  // Persistent reference to `this` (the JS WhisperModel object) keeps the
  // model alive across the async boundary even if JS drops all other refs.
  Napi::ObjectReference modelRef = Napi::Persistent(info.This().As<Napi::Object>());

  auto* worker = new TranscribeWorker(
      env, deferred, std::move(modelRef), this,
      std::move(pcm), std::move(language), translate);
  worker->Queue();
  return deferred.Promise();
}
```

Update `WhisperModel::~WhisperModel` to be the safety net:

```cpp
WhisperModel::~WhisperModel() {
  // By the time the destructor runs, no JS references exist (Napi::ObjectWrap
  // semantics) and no in-flight worker can hold a Persistent ref to us.
  // So inflight_ MUST be zero here. Assert in debug builds; in release just
  // skip the free if for any reason it isn't, to avoid a use-after-free.
  if (inflight_.load(std::memory_order_acquire) == 0 && ctx_ != nullptr) {
    whisper_free(ctx_);
    ctx_ = nullptr;
  }
}
```

And register the method in `WhisperModel::Init`:

```cpp
// Update DefineClass call to:
Napi::Function func = DefineClass(env, "WhisperModel", {
  InstanceMethod("transcribe", &WhisperModel::Transcribe),
  InstanceMethod("free", &WhisperModel::Free),
});
```

- [ ] **Step 2: Rebuild**

```bash
pnpm run build:native > /tmp/whisper-build-step5.log 2>&1
```
Expected: success.

- [ ] **Step 3: Manual smoke test with a real WAV**

Pre-decode a sample WAV file to raw PCM using ffmpeg (we'll wire ffmpeg in Task 9; for now do it by hand):

```bash
# Use any short WAV/MP3 you have lying around; or generate one:
say -o /tmp/hello.wav "hello world this is a test"
ffmpeg -hide_banner -loglevel error -i /tmp/hello.wav -ac 1 -ar 16000 -f f32le /tmp/hello.f32

node -e "
const fs = require('fs');
const { WhisperModel } = require('./build/Release/whisper_addon.node');
const path = require('path');
const os = require('os');
const m = new WhisperModel(path.join(os.homedir(), '.agency/models/whisper/ggml-tiny.en.bin'));
const buf = fs.readFileSync('/tmp/hello.f32');
const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
m.transcribe(f32, { language: 'en' }).then(segments => {
  console.log('segments:', segments);
  m.free();
});
"
```

Expected: an array of one or more strings containing words like "hello" / "world" / "test". Exact output is non-deterministic but should be recognizable.

- [ ] **Step 4: Commit**

```bash
git add packages/whisper-local/src/addon.cc
git commit -m "Add Transcribe binding using AsyncWorker"
```

---

## Task 6: modelManager.ts — path resolution + lockfile parsing

**Files:**
- Create: `packages/whisper-local/src/modelManager.ts`
- Create: `packages/whisper-local/tests/modelManager.test.ts`
- Create: `packages/whisper-local/models.lock.json` (placeholder with zeros)

- [ ] **Step 1: Write the failing test**

Create `tests/modelManager.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveModelDir,
  resolveModelPath,
  loadLockfile,
  isModelInstalled,
  ModelManagerError,
} from "../src/modelManager.js";

describe("resolveModelDir", () => {
  const origEnv = process.env.AGENCY_WHISPER_MODELS_DIR;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.AGENCY_WHISPER_MODELS_DIR;
    else process.env.AGENCY_WHISPER_MODELS_DIR = origEnv;
  });

  it("defaults to ~/.agency/models/whisper", () => {
    delete process.env.AGENCY_WHISPER_MODELS_DIR;
    expect(resolveModelDir()).toBe(path.join(os.homedir(), ".agency/models/whisper"));
  });

  it("respects AGENCY_WHISPER_MODELS_DIR", () => {
    process.env.AGENCY_WHISPER_MODELS_DIR = "/tmp/custom";
    expect(resolveModelDir()).toBe("/tmp/custom");
  });
});

describe("resolveModelPath", () => {
  it("composes dir + ggml-<name>.bin", () => {
    expect(resolveModelPath("base.en", "/x")).toBe("/x/ggml-base.en.bin");
  });

  it("throws on unknown model name", () => {
    expect(() => resolveModelPath("not-a-real-model" as any, "/x"))
      .toThrow(ModelManagerError);
  });
});

describe("loadLockfile", () => {
  it("parses the shipped lockfile", async () => {
    const lock = await loadLockfile();
    expect(lock.schemaVersion).toBe(1);
    expect(lock.models["base"]).toBeDefined();
    expect(lock.models["base"].url).toMatch(/^https:\/\/huggingface\.co\//);
    expect(lock.models["base"].sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("isModelInstalled", () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), "whisper-test-")); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it("returns false when the file is missing", async () => {
    expect(await isModelInstalled("base.en", tmp)).toBe(false);
  });

  it("returns true when the file exists", async () => {
    await fs.writeFile(path.join(tmp, "ggml-base.en.bin"), "x");
    expect(await isModelInstalled("base.en", tmp)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/whisper-local
pnpm test:run tests/modelManager.test.ts
```
Expected: FAIL — `modelManager.js` doesn't exist.

- [ ] **Step 3: Write the implementation**

`src/modelManager.ts`:

```ts
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelName, Lockfile } from "./types.js";

const KNOWN_MODELS: readonly ModelName[] = [
  "tiny", "tiny.en",
  "base", "base.en",
  "small", "small.en",
  "medium", "medium.en",
  "large-v3", "large-v3-turbo",
];

export class ModelManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelManagerError";
  }
}

export function resolveModelDir(): string {
  const override = process.env.AGENCY_WHISPER_MODELS_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".agency/models/whisper");
}

export function resolveModelPath(name: ModelName, dir: string = resolveModelDir()): string {
  if (!KNOWN_MODELS.includes(name)) {
    throw new ModelManagerError(
      `unknown model "${name}". Choices: ${KNOWN_MODELS.join(", ")}`
    );
  }
  return path.join(dir, `ggml-${name}.bin`);
}

export async function isModelInstalled(name: ModelName, dir: string = resolveModelDir()): Promise<boolean> {
  const p = resolveModelPath(name, dir);
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Walk up from startDir until we find a directory containing package.json.
 * Same shape as agency-lang's lib/importPaths.ts:findPackageRoot — kept inline
 * here so this package has no implementation dependency on agency-lang internals.
 * Don't replace with `path.join(__dirname, "..", "..")` — that breaks if tsc
 * outDir changes (e.g. a future move from `dist/src/` to `dist/`).
 */
function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new ModelManagerError(
        `Could not find package root walking up from ${startDir} (no package.json)`
      );
    }
    dir = parent;
  }
}

const PACKAGE_ROOT = findPackageRoot(__dirname);

export async function loadLockfile(): Promise<Lockfile> {
  const lockPath = path.join(PACKAGE_ROOT, "models.lock.json");
  const text = await fs.readFile(lockPath, "utf8");
  const parsed = JSON.parse(text);
  if (parsed.schemaVersion !== 1) {
    throw new ModelManagerError(`unsupported lockfile schema version ${parsed.schemaVersion}`);
  }
  return parsed as Lockfile;
}
```

- [ ] **Step 4: Write a placeholder lockfile**

`models.lock.json` (will be populated for real in Task 8; for now, just enough to make `loadLockfile` test pass):

```json
{
  "schemaVersion": 1,
  "models": {
    "tiny":           { "url": "https://huggingface.co/placeholder", "sha256": "0000000000000000000000000000000000000000000000000000000000000000", "sizeBytes": 0 },
    "tiny.en":        { "url": "https://huggingface.co/placeholder", "sha256": "0000000000000000000000000000000000000000000000000000000000000000", "sizeBytes": 0 },
    "base":           { "url": "https://huggingface.co/placeholder", "sha256": "0000000000000000000000000000000000000000000000000000000000000000", "sizeBytes": 0 },
    "base.en":        { "url": "https://huggingface.co/placeholder", "sha256": "0000000000000000000000000000000000000000000000000000000000000000", "sizeBytes": 0 },
    "small":          { "url": "https://huggingface.co/placeholder", "sha256": "0000000000000000000000000000000000000000000000000000000000000000", "sizeBytes": 0 },
    "small.en":       { "url": "https://huggingface.co/placeholder", "sha256": "0000000000000000000000000000000000000000000000000000000000000000", "sizeBytes": 0 },
    "medium":         { "url": "https://huggingface.co/placeholder", "sha256": "0000000000000000000000000000000000000000000000000000000000000000", "sizeBytes": 0 },
    "medium.en":      { "url": "https://huggingface.co/placeholder", "sha256": "0000000000000000000000000000000000000000000000000000000000000000", "sizeBytes": 0 },
    "large-v3":       { "url": "https://huggingface.co/placeholder", "sha256": "0000000000000000000000000000000000000000000000000000000000000000", "sizeBytes": 0 },
    "large-v3-turbo": { "url": "https://huggingface.co/placeholder", "sha256": "0000000000000000000000000000000000000000000000000000000000000000", "sizeBytes": 0 }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm test:run tests/modelManager.test.ts
```
Expected: PASS (all four describe blocks). Note: the `loadLockfile` test only checks structure + URL/sha256 regex — placeholder values would fail the URL regex. **Update**: the placeholder URL above is `https://huggingface.co/placeholder` which matches `^https:\/\/huggingface\.co\//`, and the sha256 of 64 zeroes matches `[0-9a-f]{64}`. So this is fine.

- [ ] **Step 6: Commit**

```bash
git add packages/whisper-local/src packages/whisper-local/tests/modelManager.test.ts packages/whisper-local/models.lock.json
git commit -m "Add modelManager: path resolution and lockfile loading"
```

---

## Task 7: modelManager.ts — SHA-256 verification and downloader

**Files:**
- Modify: `packages/whisper-local/src/modelManager.ts`
- Modify: `packages/whisper-local/tests/modelManager.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/modelManager.test.ts`:

```ts
import { sha256OfFile, downloadModel } from "../src/modelManager.js";
import { createServer } from "node:http";
import * as crypto from "node:crypto";
import type { AddressInfo } from "node:net";

describe("sha256OfFile", () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), "whisper-sha-")); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it("computes the SHA-256 of a file", async () => {
    const f = path.join(tmp, "hello");
    await fs.writeFile(f, "hello world");
    expect(await sha256OfFile(f)).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
    );
  });
});

describe("downloadModel", () => {
  let tmp: string;
  let server: ReturnType<typeof createServer>;
  let url: string;
  const payload = Buffer.from("synthetic model bytes for testing");
  // Compute the SHA at test-init time; do NOT hardcode it. A wrong hardcoded
  // value would silently turn the success-path test into a failure-path test.
  const payloadSha = crypto.createHash("sha256").update(payload).digest("hex");

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "whisper-dl-"));
    await new Promise<void>((resolve) => {
      server = createServer((_req, res) => { res.end(payload); });
      server.listen(0, () => {
        const port = (server.address() as AddressInfo).port;
        url = `http://127.0.0.1:${port}/model.bin`;
        resolve();
      });
    });
  });
  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()));
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("downloads, verifies the SHA-256, and atomically writes the file", async () => {
    const entry = { url, sha256: payloadSha, sizeBytes: payload.length };
    const dest = path.join(tmp, "ggml-base.en.bin");
    await downloadModel(entry, dest);
    const wrote = await fs.readFile(dest);
    expect(wrote.equals(payload)).toBe(true);
    // No .partial left behind
    expect(await fs.readdir(tmp)).toEqual(["ggml-base.en.bin"]);
  });

  it("rejects mismatched SHA-256 and deletes the partial", async () => {
    const entry = { url, sha256: "f".repeat(64), sizeBytes: payload.length };
    const dest = path.join(tmp, "ggml-base.en.bin");
    await expect(downloadModel(entry, dest)).rejects.toThrow(/SHA-256 mismatch/);
    expect(await fs.readdir(tmp)).toEqual([]);
  });
});
```

Note: `payloadSha` is computed at test runtime from the same buffer the server serves; no hardcoded hash to maintain.

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm test:run tests/modelManager.test.ts
```
Expected: FAIL — `sha256OfFile` and `downloadModel` don't exist yet.

- [ ] **Step 3: Implement**

Append to `src/modelManager.ts`:

```ts
import * as crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import type { LockfileEntry } from "./types.js";

export async function sha256OfFile(filepath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const fd = await fs.open(filepath, "r");
  try {
    const stream = fd.createReadStream();
    for await (const chunk of stream) hash.update(chunk as Buffer);
  } finally {
    await fd.close();
  }
  return hash.digest("hex");
}

export async function downloadModel(entry: LockfileEntry, dest: string): Promise<void> {
  // Defense in depth: even though the lockfile is committed and reviewed, refuse
  // to fetch over plaintext. The SHA-256 check below would still catch tampering,
  // but rejecting non-HTTPS up front avoids exposing the user's network to a
  // downgrade attack and makes lockfile-tampering review easier.
  // Allow http://127.0.0.1 and http://localhost for tests.
  const isLocalTest = /^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(entry.url);
  if (!entry.url.startsWith("https://") && !isLocalTest) {
    throw new ModelManagerError(
      `refusing to download model over non-HTTPS URL: ${entry.url}`
    );
  }

  await fs.mkdir(path.dirname(dest), { recursive: true });
  const partial = `${dest}.partial`;

  // Clean any leftover partial from a prior failed attempt.
  await fs.rm(partial, { force: true });

  const response = await fetch(entry.url);
  if (!response.ok || !response.body) {
    throw new ModelManagerError(
      `failed to download model from ${entry.url}: HTTP ${response.status}`
    );
  }

  const hash = crypto.createHash("sha256");
  const out = createWriteStream(partial);
  let bytes = 0;

  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      bytes += value.byteLength;
      if (!out.write(value)) {
        await new Promise<void>((resolve) => out.once("drain", () => resolve()));
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err: unknown) => err ? reject(err) : resolve());
    });
  } catch (err) {
    await fs.rm(partial, { force: true });
    throw err;
  }

  const actual = hash.digest("hex");
  if (actual !== entry.sha256) {
    await fs.rm(partial, { force: true });
    throw new ModelManagerError(
      `SHA-256 mismatch (expected ${entry.sha256}, got ${actual}). ` +
      `The downloaded file has been deleted. This may indicate a corrupted download or compromised mirror.`
    );
  }

  await fs.rename(partial, dest);
}

export async function ensureModel(name: ModelName, dir: string = resolveModelDir()): Promise<string> {
  const target = resolveModelPath(name, dir);
  if (await isModelInstalled(name, dir)) return target;
  const lock = await loadLockfile();
  const entry = lock.models[name];
  if (!entry) {
    throw new ModelManagerError(`no lockfile entry for model "${name}"`);
  }
  if (entry.sha256 === "0".repeat(64)) {
    throw new ModelManagerError(
      `model "${name}" has a placeholder hash in models.lock.json. ` +
      `The lockfile has not been populated yet (this is a setup bug).`
    );
  }
  if (process.stderr.isTTY) {
    process.stderr.write(`Downloading ${name} (~${Math.round(entry.sizeBytes / 1e6)} MB) ...\n`);
  }
  await downloadModel(entry, target);
  return target;
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm test:run tests/modelManager.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/whisper-local/src/modelManager.ts packages/whisper-local/tests/modelManager.test.ts
git commit -m "Add downloadModel + sha256OfFile + ensureModel"
```

---

## Task 8: Populate models.lock.json with real hashes

**Files:**
- Modify: `packages/whisper-local/models.lock.json`
- Create: `packages/whisper-local/scripts/generate-lockfile.sh`

This is the one-time, manual security-critical step. The lockfile is the trust anchor: every model download is verified against the hashes committed here.

- [ ] **Step 1: Identify a HuggingFace commit SHA to pin**

Visit `https://huggingface.co/ggerganov/whisper.cpp/commits/main`, pick a recent commit (or `main`'s current HEAD if no specific reason otherwise). Record its 40-char SHA.

For this plan, assume `<HF_COMMIT>` is that SHA. The URL template becomes:
`https://huggingface.co/ggerganov/whisper.cpp/resolve/<HF_COMMIT>/ggml-<name>.bin`

- [ ] **Step 2: Write the generation script**

`scripts/generate-lockfile.sh`:

```bash
#!/usr/bin/env bash
# Downloads each whisper model, records SHA-256 + size into models.lock.json.
# Idempotent: re-running it overwrites the lockfile but uses the same URLs.
set -euo pipefail

if [ -z "${HF_COMMIT:-}" ]; then
  echo "HF_COMMIT env var required (40-char HuggingFace commit SHA)"
  exit 1
fi

PKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

MODELS=(tiny tiny.en base base.en small small.en medium medium.en large-v3 large-v3-turbo)

echo '{ "schemaVersion": 1, "models": {' > "$PKG_ROOT/models.lock.json"
SEP=""
for m in "${MODELS[@]}"; do
  URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/$HF_COMMIT/ggml-$m.bin"
  echo "Downloading $URL ..."
  curl -fSL "$URL" -o "$TMP/$m.bin"
  SHA=$(shasum -a 256 "$TMP/$m.bin" | awk '{print $1}')
  SIZE=$(stat -f %z "$TMP/$m.bin" 2>/dev/null || stat -c %s "$TMP/$m.bin")
  printf '%s  "%s": { "url": "%s", "sha256": "%s", "sizeBytes": %s }\n' \
    "$SEP" "$m" "$URL" "$SHA" "$SIZE" >> "$PKG_ROOT/models.lock.json"
  SEP=","
done
echo '} }' >> "$PKG_ROOT/models.lock.json"

# Pretty-print
node -e "const fs=require('fs'); const p='$PKG_ROOT/models.lock.json'; fs.writeFileSync(p, JSON.stringify(JSON.parse(fs.readFileSync(p,'utf8')), null, 2));"

echo "Lockfile written. Total download: ~$(du -sh $TMP | awk '{print $1}')"
```

Make executable: `chmod +x packages/whisper-local/scripts/generate-lockfile.sh`

- [ ] **Step 3: Run it**

```bash
cd packages/whisper-local
HF_COMMIT=<the-sha-you-picked> bash scripts/generate-lockfile.sh
```

Expected: ~7 GB of downloads, completes in 5–30 minutes depending on bandwidth. Final `models.lock.json` has real hashes and sizes.

- [ ] **Step 4: Independently verify at least one hash**

Pick one model (e.g. `tiny.en`, ~75 MB) and verify the SHA from a different machine or network. This is the moment to detect a network-level tampering.

```bash
# On a different machine / VPN:
curl -fL https://huggingface.co/ggerganov/whisper.cpp/resolve/<HF_COMMIT>/ggml-tiny.en.bin | shasum -a 256
```
Expected: matches the value in `models.lock.json` under `tiny.en.sha256`.

- [ ] **Step 5: Re-run modelManager tests**

The `loadLockfile` test will now load the real file. The sha256 regex `^[0-9a-f]{64}$` still passes.

```bash
pnpm test:run tests/modelManager.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/whisper-local/models.lock.json packages/whisper-local/scripts/generate-lockfile.sh
git commit -m "$(cat <<'EOF'
Populate models.lock.json with real SHA-256 hashes

URLs are pinned to HuggingFace commit <HF_COMMIT> (immutable). Hashes
generated by scripts/generate-lockfile.sh; tiny.en hash independently
verified from a separate network.
EOF
)"
```

---

## Task 9: ffmpeg.ts — spawn ffmpeg, capture PCM

**Files:**
- Create: `packages/whisper-local/src/ffmpeg.ts`
- Create: `packages/whisper-local/tests/ffmpeg.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/ffmpeg.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

vi.mock("node:child_process");
import { spawn } from "node:child_process";

import { buildFfmpegArgs, decodeToPcm, FfmpegError } from "../src/ffmpeg.js";

describe("buildFfmpegArgs", () => {
  it("emits the expected pipeline for a given input", () => {
    expect(buildFfmpegArgs("/path/to/input.m4a")).toEqual([
      "-hide_banner",
      "-loglevel", "error",
      "-i", "/path/to/input.m4a",
      "-ac", "1",
      "-ar", "16000",
      "-f", "f32le",
      "-",
    ]);
  });
});

describe("decodeToPcm", () => {
  function mockSpawn(opts: { exitCode: number; stdoutChunks?: Buffer[]; stderrText?: string; emitError?: Error }) {
    const proc = new EventEmitter() as any;
    proc.stdout = Readable.from(opts.stdoutChunks ?? []);
    proc.stderr = Readable.from([Buffer.from(opts.stderrText ?? "")]);
    proc.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    setImmediate(() => {
      if (opts.emitError) proc.emit("error", opts.emitError);
      else proc.emit("close", opts.exitCode);
    });
    (spawn as any).mockReturnValue(proc);
    return proc;
  }

  beforeEach(() => { vi.mocked(spawn).mockReset(); });

  it("returns a Float32Array from ffmpeg stdout", async () => {
    const f32 = new Float32Array([0.1, -0.2, 0.3, -0.4]);
    mockSpawn({ exitCode: 0, stdoutChunks: [Buffer.from(f32.buffer)] });
    const out = await decodeToPcm("/in.wav");
    expect(Array.from(out)).toEqual([
      expect.closeTo(0.1, 6),
      expect.closeTo(-0.2, 6),
      expect.closeTo(0.3, 6),
      expect.closeTo(-0.4, 6),
    ]);
  });

  it("throws FfmpegError if ffmpeg is missing", async () => {
    mockSpawn({ exitCode: 0, emitError: Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }) });
    await expect(decodeToPcm("/in.wav")).rejects.toThrow(/ffmpeg not found/);
  });

  it("throws FfmpegError with stderr on non-zero exit", async () => {
    mockSpawn({ exitCode: 1, stderrText: "ffmpeg: invalid file format\n" });
    await expect(decodeToPcm("/in.wav")).rejects.toThrow(/invalid file format/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test:run tests/ffmpeg.test.ts
```
Expected: FAIL (no implementation).

- [ ] **Step 3: Implement**

`src/ffmpeg.ts`:

```ts
import { spawn } from "node:child_process";

export class FfmpegError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FfmpegError";
  }
}

export function buildFfmpegArgs(filepath: string): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-i", filepath,
    "-ac", "1",
    "-ar", "16000",
    "-f", "f32le",
    "-",
  ];
}

function ffmpegInstallHint(): string {
  switch (process.platform) {
    case "darwin": return "Install with: brew install ffmpeg";
    case "linux":  return "Install with: apt install ffmpeg (or your distro's equivalent)";
    case "win32":  return "Install from https://ffmpeg.org/download.html and ensure it's on PATH";
    default:       return "Install ffmpeg and ensure it's on PATH";
  }
}

export async function decodeToPcm(filepath: string): Promise<Float32Array> {
  const args = buildFfmpegArgs(filepath);
  const proc = spawn("ffmpeg", args);

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  proc.stdout!.on("data", (c: Buffer) => stdoutChunks.push(c));
  proc.stderr!.on("data", (c: Buffer) => stderrChunks.push(c));

  return new Promise<Float32Array>((resolve, reject) => {
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new FfmpegError(`ffmpeg not found on PATH. ${ffmpegInstallHint()}`));
      } else {
        reject(new FfmpegError(`failed to spawn ffmpeg: ${err.message}`));
      }
    });
    proc.on("close", (code: number | null) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(new FfmpegError(`ffmpeg exited with code ${code}: ${stderr}`));
        return;
      }
      const buf = Buffer.concat(stdoutChunks);
      if (buf.byteLength % 4 !== 0) {
        reject(new FfmpegError(`ffmpeg produced ${buf.byteLength} bytes, not a multiple of 4`));
        return;
      }
      const f32 = new Float32Array(buf.byteLength / 4);
      for (let i = 0; i < f32.length; i++) {
        f32[i] = buf.readFloatLE(i * 4);
      }
      resolve(f32);
    });
  });
}
```

Note: copy bytes into a fresh Float32Array (rather than `new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength/4)`) to handle the case where the buffer offset isn't 4-byte aligned, which is rare but possible with `Buffer.concat`.

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm test:run tests/ffmpeg.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/whisper-local/src/ffmpeg.ts packages/whisper-local/tests/ffmpeg.test.ts
git commit -m "Add ffmpeg shell-out for PCM decoding"
```

---

## Task 10: transcribe.ts — orchestration layer

**Files:**
- Create: `packages/whisper-local/src/transcribe.ts`
- Create: `packages/whisper-local/tests/transcribe.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/transcribe.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/modelManager.js", () => ({
  ensureModel: vi.fn(),
  resolveModelPath: vi.fn(),
}));
vi.mock("../src/ffmpeg.js", () => ({
  decodeToPcm: vi.fn(),
}));
vi.mock("../src/addon.js", () => {
  const WhisperModel = vi.fn();
  return { loadAddon: () => ({ WhisperModel }) };
});

import * as modelManager from "../src/modelManager.js";
import * as ffmpeg from "../src/ffmpeg.js";
import { transcribe, _clearHandleCache } from "../src/transcribe.js";
import * as addonMod from "../src/addon.js";

describe("transcribe", () => {
  let mockInstance: any;

  beforeEach(() => {
    _clearHandleCache();
    vi.mocked(modelManager.ensureModel).mockResolvedValue("/path/to/ggml-base.bin");
    vi.mocked(ffmpeg.decodeToPcm).mockResolvedValue(new Float32Array([0.1, 0.2]));
    mockInstance = {
      transcribe: vi.fn().mockResolvedValue(["hello ", "world"]),
      free: vi.fn(),
    };
    const { WhisperModel } = addonMod.loadAddon();
    (WhisperModel as any).mockImplementation(() => mockInstance);
  });

  it("joins segments and returns the text", async () => {
    const out = await transcribe("audio.m4a", "en", "base");
    expect(out).toBe("hello world");
  });

  it("forwards language and uses default model", async () => {
    await transcribe("audio.m4a", "en");
    expect(modelManager.ensureModel).toHaveBeenCalledWith("base");
    expect(mockInstance.transcribe).toHaveBeenCalledWith(
      expect.any(Float32Array),
      { language: "en", translate: false }
    );
  });

  it("caches model handles across calls", async () => {
    await transcribe("audio1.m4a", "en", "base");
    await transcribe("audio2.m4a", "en", "base");
    const { WhisperModel } = addonMod.loadAddon();
    expect(WhisperModel).toHaveBeenCalledTimes(1);
  });

  it("rejects empty filepath", async () => {
    await expect(transcribe("", "en", "base")).rejects.toThrow(/filepath/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test:run tests/transcribe.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

First, an addon loader module so it can be mocked separately. `src/addon.ts`:

```ts
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

type WhisperModelCtor = new (modelPath: string) => {
  transcribe(pcm: Float32Array, opts?: { language?: string; translate?: boolean }): Promise<string[]>;
  free(): void;
};

let cached: { WhisperModel: WhisperModelCtor } | null = null;

export function loadAddon(): { WhisperModel: WhisperModelCtor } {
  if (cached) return cached;
  // dist/src/addon.js → ../../build/Release/whisper_addon.node
  const addonPath = path.join(__dirname, "..", "..", "build", "Release", "whisper_addon.node");
  cached = require(addonPath);
  return cached!;
}
```

Then `src/transcribe.ts`:

```ts
import { decodeToPcm } from "./ffmpeg.js";
import { ensureModel } from "./modelManager.js";
import { loadAddon } from "./addon.js";
import type { ModelName } from "./types.js";

const handleCache = new Map<string, { instance: any }>();

export function _clearHandleCache(): void {
  for (const { instance } of handleCache.values()) {
    try { instance.free(); } catch { /* ignore */ }
  }
  handleCache.clear();
}

export async function transcribe(
  filepath: string,
  language: string = "",
  model: ModelName = "base"
): Promise<string> {
  if (!filepath) {
    throw new Error("transcribe: filepath is required");
  }
  const modelPath = await ensureModel(model);
  let entry = handleCache.get(modelPath);
  if (!entry) {
    const { WhisperModel } = loadAddon();
    entry = { instance: new WhisperModel(modelPath) };
    handleCache.set(modelPath, entry);
  }
  const pcm = await decodeToPcm(filepath);
  const segments = await entry.instance.transcribe(pcm, { language, translate: false });
  return segments.join("").trim();
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm test:run tests/transcribe.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/whisper-local/src/addon.ts packages/whisper-local/src/transcribe.ts packages/whisper-local/tests/transcribe.test.ts
git commit -m "Add transcribe() orchestration with handle caching"
```

---

## Task 11: index.agency — public Agency wrapper

**Files:**
- Create: `packages/whisper-local/index.agency`

- [ ] **Step 1: Write the wrapper**

`index.agency`:

```
/**
## Installation

```
npm install @agency-lang/whisper-local
```

Requires `cmake`, a C++17 compiler, and `ffmpeg` on PATH.

## Usage

```ts
import { transcribe } from "pkg::@agency-lang/whisper-local"

node main() {
  const text = transcribe("interview.m4a", "en", "base.en")
  print(text)
}
```

The first call downloads the requested model (~150 MB for "base", more for
larger sizes) into `~/.agency/models/whisper/`. Subsequent calls reuse the
local file with no network access.
*/

import { transcribe as transcribeImpl } from "./dist/src/transcribe.js"

/// Transcribe an audio file locally using whisper.cpp. No network at runtime.
export def transcribe(filepath: string, language: string = "", model: string = "base"): string {
  return transcribeImpl(filepath, language, model)
}
```

- [ ] **Step 2: Build the wrapper**

From the package root:

```bash
pnpm run build
```

Expected: produces `dist/` and `build/Release/whisper_addon.node`. The Agency wrapper isn't compiled here — it's compiled by `agency` when consumers import it. We're just confirming the build chain still works.

Save output: `pnpm run build > /tmp/whisper-build-step11.log 2>&1`.

- [ ] **Step 3: Smoke-test from a temporary Agency file**

Create `/tmp/whisper-smoke.agency`:

```
import { transcribe } from "pkg::@agency-lang/whisper-local"
node main() {
  // assumes you have an audio file at /tmp/sample.wav and tiny.en downloaded
  const text = transcribe("/tmp/sample.wav", "en", "tiny.en")
  print(text)
}
```

This step is optional and requires manual setup; if your environment doesn't have a sample WAV, skip it and rely on later integration tests.

- [ ] **Step 4: Commit**

```bash
git add packages/whisper-local/index.agency
git commit -m "Add Agency-facing transcribe() wrapper"
```

---

## Task 12: CLI — build / pull / list / verify

**Files:**
- Create: `packages/whisper-local/src/cli.ts`

The `build` subcommand is the user-invoked replacement for the postinstall hook. It runs `cmake-js compile` from the package root and is the only path through which a user installing this package compiles native code. Documented prominently in the README's installation section.

- [ ] **Step 1: Implement the CLI**

`src/cli.ts`:

```ts
#!/usr/bin/env node
import {
  loadLockfile,
  resolveModelDir,
  resolveModelPath,
  isModelInstalled,
  ensureModel,
  sha256OfFile,
  ModelManagerError,
} from "./modelManager.js";
import type { ModelName } from "./types.js";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no package.json found above ${startDir}`);
    dir = parent;
  }
}

async function cmdBuild() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgRoot = findPackageRoot(here);
  console.log(`Building native addon in ${pkgRoot} ...`);
  console.log("This compiles vendored whisper.cpp + ggml from source. Expect 30-90 seconds.");
  console.log("Requires: cmake >= 3.18, a C++17 compiler. (ffmpeg is needed at runtime, not build time.)");

  // We deliberately spawn the locally-installed cmake-js binary rather than
  // invoking node's require system, so the user sees real cmake output and
  // we don't accidentally execute vendored C++ via a hidden code path.
  const cmakeJs = path.join(pkgRoot, "node_modules", ".bin", "cmake-js");
  if (!existsSync(cmakeJs)) {
    console.error(`cmake-js not found at ${cmakeJs}.`);
    console.error(`Run \`npm install\` (or \`pnpm install\`) inside ${pkgRoot} first.`);
    process.exit(5);
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmakeJs, ["compile", "--runtime=node"], {
      cwd: pkgRoot,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`cmake-js exited with code ${code}`));
    });
  });

  const addonPath = path.join(pkgRoot, "build", "Release", "whisper_addon.node");
  if (!existsSync(addonPath)) {
    console.error(`Build reported success but addon not found at ${addonPath}.`);
    process.exit(6);
  }
  console.log(`Built: ${addonPath}`);
}

async function cmdPull(name: string) {
  await ensureModel(name as ModelName);
  console.log(`Installed: ${resolveModelPath(name as ModelName)}`);
}

async function cmdList() {
  const dir = resolveModelDir();
  const lock = await loadLockfile();
  console.log(`Models directory: ${dir}\n`);
  for (const [name, entry] of Object.entries(lock.models)) {
    const installed = await isModelInstalled(name as ModelName, dir);
    const sizeMb = Math.round(entry.sizeBytes / 1e6);
    const tag = installed ? "✓" : " ";
    console.log(`  ${tag}  ${name.padEnd(16)} ${String(sizeMb).padStart(5)} MB`);
  }
}

async function cmdVerify(name: string) {
  const path = resolveModelPath(name as ModelName);
  const lock = await loadLockfile();
  const entry = lock.models[name as ModelName];
  if (!entry) throw new ModelManagerError(`unknown model "${name}"`);
  try {
    await fs.access(path);
  } catch {
    console.error(`Not installed: ${path}`);
    process.exit(2);
  }
  const actual = await sha256OfFile(path);
  if (actual === entry.sha256) {
    console.log(`OK: ${name} (${actual})`);
  } else {
    console.error(`MISMATCH: ${name}`);
    console.error(`  expected ${entry.sha256}`);
    console.error(`  actual   ${actual}`);
    process.exit(3);
  }
}

function usage() {
  console.error("Usage: agency-whisper <command> [args]");
  console.error("  build            Compile the native addon (run once after install)");
  console.error("  pull <model>     Download a model (e.g. base.en)");
  console.error("  list             List supported models and installation status");
  console.error("  verify <model>   Re-hash an installed model and compare to lockfile");
  process.exit(1);
}

const [, , cmd, ...rest] = process.argv;
try {
  switch (cmd) {
    case "build":  await cmdBuild(); break;
    case "pull":   if (!rest[0]) usage(); await cmdPull(rest[0]); break;
    case "list":   await cmdList(); break;
    case "verify": if (!rest[0]) usage(); await cmdVerify(rest[0]); break;
    default: usage();
  }
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(4);
}
```

- [ ] **Step 2: Build**

```bash
pnpm run build:ts
```

- [ ] **Step 3: Smoke-test**

```bash
node dist/src/cli.js list
```
Expected: prints the list of 10 models, each marked installed (✓) or not.

```bash
node dist/src/cli.js verify tiny.en   # if tiny.en is installed
```
Expected: `OK: tiny.en <hash>` (or `MISMATCH` if the file is wrong).

- [ ] **Step 4: Commit**

```bash
git add packages/whisper-local/src/cli.ts
git commit -m "Add agency-whisper CLI: pull, list, verify"
```

---

## Task 13: Agency-js wrapper test

**Files:**
- Create: `packages/whisper-local/tests/agency-js/transcribe.test.ts`

Verifies the `.agency` wrapper correctly forwards parameters into JS. Uses a stub JS module rather than the real native addon.

- [ ] **Step 1: Look at an existing agency-js test for patterns**

Read `packages/agency-lang/tests/agency-js/` for the test harness shape. (The plan can't reproduce that here — patterns vary; the implementer should match style.)

- [ ] **Step 2: Write the test**

The exact API for agency-js tests depends on the harness. Sketch:

```ts
import { describe, it, expect } from "vitest";
import { runAgency } from "agency-lang/test-harness"; // adjust to actual harness

describe("transcribe wrapper", () => {
  it("forwards filepath, language, model to JS transcribeImpl", async () => {
    let captured: any = null;
    const result = await runAgency({
      file: "tests/agency-js/fixtures/transcribe.agency",
      stubs: {
        "./dist/src/transcribe.js": {
          transcribe: (...args: unknown[]) => {
            captured = args;
            return "stubbed text";
          },
        },
      },
    });
    expect(result).toBe("stubbed text");
    expect(captured).toEqual(["audio.wav", "en", "base.en"]);
  });
});
```

And fixture `tests/agency-js/fixtures/transcribe.agency`:
```
import { transcribe } from "../../index.agency"
node main() {
  return transcribe("audio.wav", "en", "base.en")
}
```

- [ ] **Step 3: Run the test**

```bash
pnpm test:run tests/agency-js/transcribe.test.ts
```
Expected: PASS.

If the harness API differs from the sketch above, adjust. The intent is fixed: stub the JS module, run the .agency wrapper, assert args flowed through.

- [ ] **Step 4: Commit**

```bash
git add packages/whisper-local/tests/agency-js
git commit -m "Add agency-js test for transcribe wrapper param forwarding"
```

---

## Task 14: Integration test (slow, gated)

**Files:**
- Create: `packages/whisper-local/tests/integration.test.ts`
- Create: `packages/whisper-local/tests/fixtures/hello.wav`

- [ ] **Step 1: Copy the existing fixture WAV**

A pre-recorded `hello.wav` already exists at the repo root: `packages/agency-lang/hello.wav` (RIFF, 16-bit PCM, mono, 48 kHz). Copy it into the package's fixture directory:

```bash
mkdir -p packages/whisper-local/tests/fixtures
cp packages/agency-lang/hello.wav packages/whisper-local/tests/fixtures/hello.wav
```

Verify it copied correctly:

```bash
file packages/whisper-local/tests/fixtures/hello.wav
# Expected: RIFF (little-endian) data, WAVE audio, Microsoft PCM, 16 bit, mono 48000 Hz
```

Do NOT regenerate via `say` — earlier drafts of this plan attempted that and the macOS `say` command does not produce a standard WAV by default (it emits AIFF regardless of the `.wav` extension), and `ffmpeg ... -i hello.wav -o hello.wav.tmp.wav && mv` is fragile if either step fails.

- [ ] **Step 2: Write the test**

```ts
import { describe, it, expect } from "vitest";
import { transcribe, _clearHandleCache } from "../src/transcribe.js";

const SLOW = process.env.AGENCY_RUN_SLOW === "1";

describe.skipIf(!SLOW)("integration: real transcription", () => {
  it("transcribes hello.wav with tiny.en", async () => {
    _clearHandleCache();
    const text = await transcribe("tests/fixtures/hello.wav", "en", "tiny.en");
    // The fixture says "hello" (and likely a brief greeting). Adjust the
    // regex to match the actual content of hello.wav once the implementer
    // has run the test once and observed the output. Keep it a substring
    // match, not exact equality, since whisper output is non-deterministic.
    expect(text.toLowerCase()).toMatch(/hello/);
  }, 60_000);
});
```

- [ ] **Step 3: Run the test**

First normally — should be skipped:
```bash
pnpm test:run tests/integration.test.ts
```
Expected: 1 test skipped.

Then gated:
```bash
AGENCY_RUN_SLOW=1 pnpm test:run tests/integration.test.ts > /tmp/whisper-integration.log 2>&1
```
Expected: downloads `tiny.en` if not present (~75 MB), transcribes, passes assertions. Total time: 10–60 seconds depending on hardware and whether the model was already cached.

- [ ] **Step 4: Commit**

```bash
git add packages/whisper-local/tests/integration.test.ts packages/whisper-local/tests/fixtures
git commit -m "Add slow integration test gated by AGENCY_RUN_SLOW=1"
```

---

## Task 15: README — install, usage, models, credits

**Files:**
- Modify: `packages/whisper-local/README.md`

Replace the skeleton with the full README. The Credits section is the legal-attribution discharge for whisper.cpp/ggml (MIT).

- [ ] **Step 1: Write the README**

```markdown
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

## Not in v0

- Prebuilt binaries (will arrive via an optional-deps platform matrix).
- Windows source-build support.
- Streaming partial results.
- Speaker diarization.
- Translation mode.

## Credits

This package vendors and depends on:

- **[whisper.cpp](https://github.com/ggml-org/whisper.cpp)** by Georgi Gerganov and contributors — MIT License. See `vendor/whisper.cpp/LICENSE`. We use a pinned release; see `vendor/whisper.cpp/VERSION`.
- **[ggml](https://github.com/ggml-org/ggml)** by Georgi Gerganov and contributors — MIT License. Vendored alongside whisper.cpp.
- **[node-addon-api](https://github.com/nodejs/node-addon-api)** by the Node.js project — MIT License.
- **[cmake-js](https://github.com/cmake-js/cmake-js)** — MIT License.

Audio decoding shells out to your system's **[ffmpeg](https://ffmpeg.org)**, which is not bundled or distributed with this package.

## License

ISC. See repository root LICENSE file. Vendored whisper.cpp + ggml source is MIT-licensed; see `vendor/whisper.cpp/LICENSE` for that notice.
```

- [ ] **Step 2: Commit**

```bash
git add packages/whisper-local/README.md
git commit -m "Add full README with install, API, models, credits sections"
```

---

## Task 16: Final integration — workspace install + smoke

**Files:** none new. This is a verification task.

- [ ] **Step 1: Clean install from the repo root**

```bash
cd /Users/adit/agency-lang
rm -rf packages/whisper-local/build
rm -rf packages/whisper-local/dist
rm -rf packages/whisper-local/node_modules
pnpm install > /tmp/whisper-clean-install.log 2>&1
```

Expected: `pnpm install` succeeds quickly (no native compilation occurs because there is no install hook). Brace expansion (`{build,dist,node_modules}`) is avoided here because it isn't portable across all shells — three explicit `rm`s instead.

- [ ] **Step 2: Build the native addon explicitly**

```bash
cd packages/whisper-local
node dist/src/cli.js build > /tmp/whisper-build-step16.log 2>&1
# (or, after publishing: npx -p @agency-lang/whisper-local agency-whisper build)
```

Expected: cmake configures, builds ggml + whisper + the addon. Output: `build/Release/whisper_addon.node`. Total time: 30-120 seconds. This is the user-facing replacement for the postinstall hook.

Note: this requires `dist/src/cli.js` to exist, which means `pnpm run build:ts` must have run during Task 12. If not, run it now.

- [ ] **Step 3: Run the full test suite for this package**

```bash
pnpm test:run > /tmp/whisper-all-tests.log 2>&1
```
Expected: all unit + agency-js tests pass. Integration test is skipped (not gated).

- [ ] **Step 4: Run the gated integration test**

```bash
AGENCY_RUN_SLOW=1 pnpm test:run tests/integration.test.ts > /tmp/whisper-slow-test.log 2>&1
```
Expected: passes. Logs show download of tiny.en if needed.

- [ ] **Step 5: Verify the CLI is wired up**

```bash
node dist/src/cli.js list
```
Expected: prints the 10-model table.

- [ ] **Step 6: Tag a no-op commit closing the implementation**

```bash
git commit --allow-empty -m "$(cat <<'EOF'
Complete @agency-lang/whisper-local v0.0.1

Local Whisper transcription for Agency. Source-build only; prebuilts to
follow. All unit + agency-js tests pass; integration test passes under
AGENCY_RUN_SLOW=1.
EOF
)"
```

(Optional — only if you want a marker commit. Otherwise skip.)

---

## Task 17: CI workflow

**Files:**
- Create: `.github/workflows/whisper-local.yml`

The existing `.github/workflows/test.yml` runs `pnpm install && make && pnpm test:run` on `ubuntu-latest` for every push and PR. Two reasons we don't add whisper-local to that workflow:

1. **Build cost.** Compiling vendored whisper.cpp + ggml from source adds ~60-90 seconds to every CI run for unrelated changes.
2. **Test cost.** The integration test downloads a ~75 MB model and runs CPU inference; it can't run on every PR.

Strategy: a separate workflow gated on path filters that runs only when files under `packages/whisper-local/**` change.

- [ ] **Step 1: Write the workflow**

`.github/workflows/whisper-local.yml`:

```yaml
# Security: all third-party actions pinned to SHA. Mirrors the policy in test.yml.
name: whisper-local CI

on:
  push:
    branches: [ "main" ]
    paths:
      - "packages/whisper-local/**"
      - ".github/workflows/whisper-local.yml"
  pull_request:
    branches: [ "main" ]
    paths:
      - "packages/whisper-local/**"
      - ".github/workflows/whisper-local.yml"

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4

      - name: Set up pnpm
        uses: pnpm/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa # v4
        with:
          version: 9
          run_install: false

      - name: Set up Node.js
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 22.x
          cache: 'pnpm'

      - name: Install system dependencies (cmake, ffmpeg, build-essential)
        run: |
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends cmake build-essential ffmpeg

      - name: Install npm dependencies (no native build runs — no install hook)
        run: pnpm install

      - name: Build TypeScript
        working-directory: packages/whisper-local
        run: pnpm run build:ts

      - name: Build native addon (explicit; mirrors what users run)
        working-directory: packages/whisper-local
        run: node dist/src/cli.js build

      - name: Run unit tests (modelManager, ffmpeg, transcribe)
        working-directory: packages/whisper-local
        run: pnpm test:run

      # The slow integration test downloads ~75 MB and runs whisper inference.
      # We do run it in CI because it's the only end-to-end check that the
      # native build, model download, ffmpeg pipe, and addon together work.
      # If this becomes a CI-time problem, gate behind a workflow_dispatch.
      - name: Run integration test (downloads tiny.en model)
        working-directory: packages/whisper-local
        env:
          AGENCY_RUN_SLOW: "1"
        run: pnpm test:run tests/integration.test.ts
        timeout-minutes: 10
```

- [ ] **Step 2: Trigger the workflow on a no-op PR or push**

Push the branch and confirm the workflow runs only when `packages/whisper-local/**` files are touched. To validate that the path filter excludes other PRs, push a small change to (e.g.) `packages/agency-lang/README.md` on a separate branch and confirm whisper-local CI does NOT trigger.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/whisper-local.yml
git commit -m "Add whisper-local CI: build addon + run tests on ubuntu-latest"
```

---

## Task 18: Developer documentation

**Files:**
- Create: `packages/whisper-local/docs/DEV.md`

Write this LAST, after Tasks 1-17 are complete. It captures the implementation details and design rationale that would be useful when modifying this package six months from now. Don't write this earlier — surprises and decisions made during implementation are exactly what this doc should capture.

- [ ] **Step 1: Wait until Tasks 1-17 are complete**

Don't start this task until everything else is done and committed. New information may surface during implementation that should appear here.

- [ ] **Step 2: Write `packages/whisper-local/docs/DEV.md`**

Required sections:

1. **Architecture overview.** The three-layer split (Agency wrapper → TypeScript orchestrator → C++ addon → vendored whisper.cpp). Include a small diagram (plain text or box-drawing). Explain why each layer exists.

2. **The trust model and security posture.** Why no postinstall. Why the SHA-256 lockfile. Why HTTPS-only download. The security boundary the package enforces and the pieces that depend on the user's discretion (running `agency-whisper build`, trusting vendored whisper.cpp source).

3. **C++ memory model in the addon.** This is the highest-risk part of the package. Document:
   - The Persistent reference / inflight counter / mutex tri-design and why each is necessary.
   - What happens when JS calls `model.free()` while a transcribe is in flight.
   - What happens when JS drops all references to a model mid-transcribe.
   - Why `whisper_full` calls are serialized per model, and the implication for callers who want concurrency (use multiple model instances).
   - The PCM ownership story (JS Float32Array → copied into std::vector → moved into worker).

4. **The model lockfile and download path.** The HuggingFace commit pinning. The atomic `.partial → rename` pattern. How `agency-whisper verify` differs from auto-rehashing on every load (and why we don't auto-rehash).

5. **The vendoring procedure.** How `scripts/vendor-whisper.sh` works. How to bump to a new whisper.cpp release (run the script with the new tag, verify SHA against GitHub release page from a separate network, update VERSION/UPSTREAM_SHA256, commit). Why we copy source instead of using a git submodule.

6. **The CMake build.** Which CMake flags matter (`WHISPER_BUILD_TESTS=OFF`, `GGML_METAL` on macOS, `CMAKE_POSITION_INDEPENDENT_CODE`). Where `cmake-js` injects its variables. Common build failures and what they mean.

7. **The handle cache in transcribe.ts.** Why we cache `WhisperModel` instances per-model-path, what `_clearHandleCache` is for (tests + explicit teardown), the implication that processes hold model memory until exit.

8. **The Agency wrapper conventions.** Why `index.agency` is a thin pass-through. Why there's no `interrupt` (transcription is fast enough not to need one; if a user wants to allow cancellation, they can wrap it themselves).

9. **The testing pyramid.** Which tests cover what (modelManager unit, ffmpeg unit, transcribe unit with mocks, agency-js wrapper, slow integration). What is intentionally not tested and why.

10. **The CI workflow.** Why it's separate from the main test.yml. What the path filter excludes. What happens when the integration test fails (likely model download failure).

11. **Lessons learned / gotchas during implementation.** Free-form section: any surprises or non-obvious decisions made while building this. Examples to start: Apple `say` command emits AIFF, not WAV. Brace expansion isn't portable. `Float32Array.ElementLength` is element count, not bytes. Etc.

- [ ] **Step 3: Cross-link from README**

Add a "For maintainers / contributors" section to README.md that points to `docs/DEV.md`.

- [ ] **Step 4: Commit**

```bash
git add packages/whisper-local/docs/DEV.md packages/whisper-local/README.md
git commit -m "Add developer documentation for whisper-local internals"
```

---

## Self-review

**Spec coverage:**
- ✅ Architecture (3 layers): Tasks 4–5 (addon), 9–10 (TS), 11 (Agency wrapper).
- ✅ `transcribe(filepath, language, model)` API: Task 11.
- ✅ No interrupt: Task 11 (wrapper has no `interrupt` statement).
- ✅ Vendor whisper.cpp, no submodule: Task 2.
- ✅ `cmake-js` source build: Task 3.
- ✅ `~/.agency/models/whisper/`: Task 6.
- ✅ Lockfile with commit-pinned HF URLs + SHA-256: Tasks 6, 7, 8.
- ✅ Download with hash verify + atomic rename: Task 7.
- ✅ HTTPS-only download (defense in depth): Task 7.
- ✅ Trust on-disk files, explicit `verify` CLI: Tasks 7 (no auto-hash) + 12 (verify command).
- ✅ ffmpeg shell-out: Task 9.
- ✅ Process-cached model handles: Task 10.
- ✅ Tests at three layers (unit, agency-js, integration): Tasks 6, 7, 9, 10, 13, 14.
- ✅ README with Credits section: Task 15.
- ✅ CI workflow (path-filtered, runs on changes only): Task 17.
- ✅ Developer documentation: Task 18.
- ✅ Source-build only v0; no prebuilts: user-invoked `agency-whisper build` (Tasks 1, 12, 15).
- ✅ Metal on macOS: Task 3 CMakeLists.

**Security posture (revisited):**
- ✅ NO postinstall / install / prepare script. `npm install` never executes vendored C++ or invokes a compiler. Native build only happens when the user explicitly runs `npx agency-whisper build` (Tasks 1, 12, 15, 16).
- ✅ Models downloaded over HTTPS only, with SHA-256 verification against committed lockfile, atomic write to disk (Task 7).
- ✅ All third-party GitHub Actions pinned to commit SHA in CI (Task 17).

**C++ memory safety:** Audited in Task 5's "Memory-safety design" section. The three known failure modes (use-after-free via JS GC, use-after-free via explicit `model.free()`, data race on concurrent `whisper_full` calls on the same context) are addressed by Persistent reference + atomic inflight counter + per-context mutex. PCM data is copied into a `std::vector<float>` before queuing the worker so the JS-managed Float32Array can be GC'd. `whisper_full_get_segment_text` results are copied into `std::string` before the ctx is touched again. `Float32Array.ElementLength()` is used (float count), not `ByteLength()` (which would over-read by 4×). Errors in `Execute()` are reported via `SetError` (NOT C++ throw, which is undefined off the JS thread).

**Placeholder scan:** No TODO/TBD strings. The `<HF_COMMIT>` token in Task 8 is a deliberate "fill this in at run-time with a specific value the engineer picks" — not a vague placeholder. The dummy SHA `0`*64 in Task 6's placeholder lockfile is intentional and replaced in Task 8.

**Type consistency:** `transcribe` signature `(filepath, language, model)` consistent across tasks 5 (addon opts), 10 (orchestrator), 11 (wrapper). `WhisperModel.transcribe(pcm, opts)` signature consistent across tasks 5 (binding) and 10 (mock). `loadAddon()` introduced in Task 10 is used only there. `_clearHandleCache` exported from `transcribe.ts` in Task 10, used in Task 14.

**Anything missing:** None blocking. Two minor follow-ups belong in a separate plan (out of scope for v0): the prebuilt-binaries optional-deps matrix, and Windows source-build support.
