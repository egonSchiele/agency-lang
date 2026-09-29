# `@agency-lang/lora`: implementation plan

**Spec:** `docs/superpowers/specs/2026-09-28-lora-package.md`. Needs
nothing from the other plans to land; its examples use the vision
plan's tools and the DX plan's adapters folder.

**Goal:** A workspace package that trains a LoRA adapter from a folder
of captioned images through one function with an effect, reads an
adapter's metadata, and exports the style-tag list so a caption loop
written by the user drops the right tags.

**Architecture:** `packages/lora/` in the shape of `packages/kokoro/`:
`index.agency` over `src/agency.ts`, which is the thin layer the
`.agency` file imports; `src/train.ts` runs the Python trainer as a
child process and turns its JSON lines into events and a result;
`src/safetensors.ts` reads a header; `trainer/train_lora_sdxl.py` is
the spike's script with the three changes the spec lists. Every path is
resolved with `_realTarget` from `agency-lang/stdlib-lib/contained.js`
before an interrupt and re-validated after, as `kokoro` does.

## Constraints

- The package adds nothing to `agency-lang`. It imports
  `agency-lang/stdlib-lib/*` helpers and uses the Python environment
  `serve` already requires. `peft` is not a dependency.
- The trainer's hidden settings live in one dictionary at the top of
  the script with a comment each. Nothing else in the script is a
  tunable.
- The trainer writes to a temp name and renames on success. The
  TypeScript side kills the child on abort and never leaves a
  `.partial` file behind that it knows about.
- A test never trains a real model except the opt-in live test.
- Follow `docs/dev/creating-packages.md` for the layout, `package.json`,
  and `tsconfig.json`.

## Task 1: Package skeleton and `loraInfo`

**Files:** Add `packages/lora/package.json`, `tsconfig.json`,
`makefile`, `README.md`, `index.agency`, `src/agency.ts`,
`src/safetensors.ts`, `src/safetensors.test.ts`, and a 2 KB fixture
`tests/fixtures/tiny.safetensors` written by a script in
`scripts/makeFixture.py` and checked in.

1. `package.json` from the template, name `@agency-lang/lora`, peer
   `agency-lang`, no runtime dependencies.
2. `safetensors.ts`: `readSafetensorsHeader(path)`: the first eight
   bytes are a little-endian length, then that many bytes of JSON; the
   `__metadata__` key holds string values. Read through
   `readStream` from `contained.js` after `fixedPath`, at most
   `MAX_HEADER_BYTES = 10_000_000`. Returns `{ metadata, tensorCount,
   sizeBytes }`.
3. `index.agency`: `export static const STYLE_TAGS` with the list from
   the spec and a doc comment saying why a caption drops them.
   `loraInfo(path)` raises `std::readBinary` with the real spelling, then calls `_loraInfo`, which maps the metadata the
   trainer writes (`base`, `trigger`, `rank`, `step`) to `LoraInfo`, and
   fails with a message naming the file when the metadata is missing a
   field, since an adapter from another trainer has none.
4. Tests: the fixture's metadata round-trips; a file with no metadata
   fails with the message; a too-long header is refused.
5. Commit: `lora package with loraInfo`.

## Task 2: The trainer script

**Files:** Add `packages/lora/trainer/train_lora_sdxl.py` from
`/Users/adit/grokking_algorithms/lora-experiments/scripts/train_lora_sdxl.py`
(the spike's script; copy it, do not link it) and
`packages/lora/trainer/test_rules.py`.

1. Move the fixed settings to `SETTINGS = {...}` at the top with a
   comment each: `alpha_equals_rank`, `batch_size`, `weight_decay`,
   `grad_clip`, `lora_targets`, `train_text_encoder = False`.
2. Progress as JSON lines on stdout: `{"event": "cached", "images": n}`,
   `{"event": "step", "step", "loss", "secondsPerStep"}`,
   `{"event": "sample", "path"}`, `{"event": "done", "path", "minutes"}`.
   Everything else goes to stderr.
3. Write the adapter to `<out>.partial` and `os.replace` it to `<out>`
   at the end. Refuse an `--out` that exists, or that does not end in
   `.safetensors`, before loading anything.
4. `--estimate-only`: print `{"images", "steps", "estimatedMinutes"}`
   from the image count, the steps, and the resolution using the
   measured rate (0.8 s per step at 1024 on an M5 Ultra, scaled by
   pixel count), and exit. This is what the TypeScript side runs before
   the interrupt.
5. Split the argument checks, the estimate, and the caption reading
   into `trainer/rules.py`, which imports no torch, so `test_rules.py`
   runs with `python3` in CI: the caption sidecar reading with and
   without a file, the trigger prepending, the estimate arithmetic, the
   `--out` refusals.
6. Commit: `The trainer script`.

## Task 3: `trainLora`

**Files:** `packages/lora/src/train.ts`, `src/train.test.ts`,
`src/python.ts`, `index.agency`, `tests/agency/trainLora.agency`, and a
fake trainer `tests/fakeTrainer.py` that prints the JSON lines and
writes an empty file.

1. Python resolution is not written here. A core PR first moves
   `choosePython` and `defaultMlxEnv` from `lib/cli/localServe.ts` to
   `lib/stdlib/localPython.ts`, re-exported from `localServe.ts` so
   nothing there changes, and this package imports it from
   `agency-lang/stdlib-lib/localPython.js` as `kokoro` imports
   `contained.js`.
2. `train.ts`: `estimateTraining(args)` runs the script with
   `--estimate-only` and parses the line. `runTraining(args, onEvent,
   signal)` spawns the script with `HF_HUB_OFFLINE=1` and
   `HF_HUB_DISABLE_TELEMETRY=1` in its environment, parses each stdout
   line into an event, resolves with the `done` event's path, and
   rejects with the last stderr lines on a non-zero exit. The abort
   signal kills the child with SIGTERM and removes `<out>.partial`
   through `safeDeleteFile`.
3. `index.agency`: `trainLora` as in the spec. Before the interrupt:
   `_realTarget` on `imagesDir` and `outPath`, the base model's
   directory from `_resolveModel` and `_findDownloadedServedModel`
   (both from `stdlib-lib/localModels.js`), the estimate. The payload
   carries every number the spec lists. After approval, `_trainLora`
   with the same spellings, which re-validates them with `fixedRoot`
   and `fixedPath` and runs. The sample grid paths from the `sample`
   events go in the result's `samples`.
4. Tests: `train.test.ts` against the fake trainer for the event
   parsing, the rename, the abort cleanup, the stderr-on-failure
   message, the environment variables; `trainLora.agency` with the
   Python pointed at the fake, a handler that checks the payload's
   numbers, approves, and checks the result's path.
5. Commit: `trainLora`.

## Task 4: Live test, README, and the examples

**Files:** `src/train.live.test.ts`, `README.md`,
`examples/trainSketchStyle.agency`, `examples/labelAndTrain.agency`.

1. The live test, gated on `AGENCY_LORA_BASE_DIR` and
   `AGENCY_IMAGE_PYTHON`: 20 steps at 512 on four fixture drawings, then
   load the result in a five-line Python check through the same
   interpreter (`pipe.load_lora_weights` on the file), expecting no
   error. Under a minute.
2. `README.md` in the shape of `kokoro`'s: install, the two functions
   and the constant, the knob table from the spec, the offline note.
3. Three examples, each a loop the user owns over single-purpose tools:
   `captionFolder.agency` (`glob`, `tagImage`, a `filter` against
   `STYLE_TAGS`, `write`); `trainSketchStyle.agency` (`trainLora` on
   an already-captioned folder); `previewAdapter.agency` (two
   `generateImageLocal` calls with one seed, `writeBinary` twice,
   `pasteImages` once). The `--approve` flags each needs go in a comment
   at the top.
4. Commit: `lora package docs, examples, and live test`.
