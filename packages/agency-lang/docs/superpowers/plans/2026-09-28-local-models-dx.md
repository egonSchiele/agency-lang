# Local models DX: implementation plan

**Spec:** `docs/superpowers/specs/2026-09-28-local-models-dx.md`.

**Goal:** Every local model has a `kind` that is recorded when it is
downloaded or inferred from its files, so `agency local serve` needs no
`--embedding`, `--speech`, or `--image` flag, `agency local list` groups
by kind, aliases carry no kind, and LoRA adapters come from a configured
folder rather than a serve flag. The spike's LoRA loading lands on top.

**Architecture:** One new module, `lib/stdlib/modelKind.ts`, owns the
`ModelKind` type and the one function that decides a model's kind from
its files, `kindOfModelDir`. The record file gains a `kind` field the
downloader writes. `planModel` in `localServe.ts` reads the kind instead
of taking one, and the old flags become assertions checked against it.
The catalog's `category` splits into `kind` and `tags`. The image
server takes `--adapters-dir` and loads adapters on first use. Nothing
about routing, the front door, or the Python scripts' security
properties changes.

## Constraints

- No dynamic imports. Objects not maps, arrays not sets, types not
  interfaces. No symlink support: `kindOfModelDir` reads through
  `contained.ts` and a symlinked component is a refusal, not a follow.
- Every kind decision is made by `kindOfModelDir` and nowhere else.
  `serve`, `list`, `download`, and the picker call it; none of them
  inspects a file themselves.
- Run `pnpm run fmt:ts` before each commit. Save test output to a file
  under the scratchpad; do not run the full Agency suite.
- The Python rules modules keep importing nothing from torch.
- `--draft` moving to positional attachment is a behavior change; it
  gets a changelog line and a test that proves the old form is refused
  with a message naming the new form.

## Task 1: `ModelKind` and `kindOfModelDir`

**Files:** Add `lib/stdlib/modelKind.ts` and `lib/stdlib/modelKind.test.ts`.
Read `lib/stdlib/modelBackend.ts` (`isModelDir`, `isDiffusersDir`,
`modelDirEntries`) and `lib/cli/diffusersImageRules.py` (the family
table's `_class_name` keys) first.

1. Write the type and the table:

   ```ts
   export type ModelKind = "chat" | "embedding" | "speech" | "image" | "vision";

   /** How a directory's files say what kind of model it holds. Checked
    *  top to bottom; the first row that matches wins. */
   type KindRule = { kind: ModelKind; matches: (dir: Root) => boolean };
   ```

   with one rule per row of the spec's inference table: `model_index.json`
   whose `_class_name` is in the image family list (read from a small
   JSON export of the Python family keys, `lib/cli/imageFamilies.json`,
   which a test checks against `diffusersImageRules.py`); `config.json`
   whose `architectures[0]` ends in `ForCausalLM` or `ForConditionalGeneration`
   is `chat`; whose `architectures[0]` ends in `Model` with a
   `sentence_transformers` folder or `pooling_config.json` beside it is
   `embedding`; a `.gguf` file is `chat`; an mlx-audio config
   (`config.json` with `"model_type"` in the speech family list from
   `mlxSpeechRules.py`) is `speech`; `model.onnx` beside
   `selected_tags.csv` is `vision`.
2. `kindOfModelDir(dir: string): ModelKind | null` returns the first
   match or null. It reads only `config.json`, `model_index.json`, and
   the directory listing, through `contained.ts`.
3. Tests: one fixture directory per row under
   `tests/fixtures/modelKinds/`, each holding only the files the rule
   reads, plus one that matches nothing. The real `model_index.json` of
   NoobAI-XL, Z-Image, and Chroma go in as fixtures. A test that the
   image family JSON equals the keys of `FAMILIES` in the Python module,
   run through `python3` as `diffusersImageServer.test.ts` does.
4. Commit: `ModelKind and kindOfModelDir`.

## Task 2: The record carries the kind

**Files:** `lib/stdlib/mlxModelRecord.ts`, `lib/stdlib/hubDownload.ts`,
`lib/cli/local.ts` (`runDownload`), `scripts/agency.ts`, and their tests.

1. Add `kind?: ModelKind` to `MlxModelRecord`. Optional, because
   records written before this exist. `readMlxModelRecord` accepts a
   record with or without it.
2. When a download completes, the downloader calls `kindOfModelDir` on
   the finished directory and writes the kind into the record. A null
   result is written as absent, not as an error: an unknown layout can
   still be served by someone who says what it is.
3. `agency local download --kind <kind>` stores the given kind instead,
   after checking it is a `ModelKind`. `runDownload` passes it through
   `_downloadModel`'s options.
4. A helper `recordedKind(dir): ModelKind | null` in `modelKind.ts`:
   the record's kind when there is a record with one, else
   `kindOfModelDir(dir)`. This is the one function every reader calls.
5. Tests: a download against the fake hub writes the kind; `--kind`
   overrides it; an old record without a kind is read and inferred.
6. Commit: `Record a model's kind when it is downloaded`.

## Task 3: `serve` reads the kind; the flags assert it

**Files:** `lib/cli/localServe.ts`, `lib/cli/localServe.test.ts`,
`scripts/agency.ts`, `docs/site/cli/local.md`.

1. `ServeKind` becomes an alias of `ModelKind` minus `vision` until Task
   6 of the vision plan adds it. `MODULES_FOR_KIND`, `readinessRequest`,
   `processLabel`, `BANNER_SUFFIX`, and `argsFor` are already keyed by
   kind and stay as they are.
2. `planModel(value, cacheDir)` drops its `kind` parameter. After
   resolving the directory it calls `recordedKind(dir)`. Null throws:
   `"<value> is a model directory of a shape agency does not know. Say
   what it is: agency local download --kind <kind> <value>"`.
3. `runServe` plans every positional value and every value from the
   three flags the same way, then checks each flagged value's planned
   kind equals the flag's kind, throwing the existing `checkKind`
   messages when not. `checkKind` loses its catalog lookup; the kind
   comes from the record now. `_localModelCategory` is deleted with its
   three callers rewritten: `checkKind` and `serveChoices` in
   `localServe.ts`, and `needsFlag`'s use in the download picker in
   `local.ts`.
4. `pickModelsToServe` and `serveChoices` list every complete
   downloaded model of every kind, grouped, with the kind as a suffix in
   the title, replacing the MLX-only filter.
5. The banner already groups by kind. Its sample call for `image` and
   `speech` stays; the chat sample stays.
6. Tests: `runServe(["noobai-dir"])` with no flag plans an image server;
   `--image` on a chat model still refuses with the old message;
   `--speech` on an image model refuses; the picker shows all kinds. The
   existing tests that pass `image: [...]` keep passing unchanged.
7. Commit: `serve takes models of any kind without a flag`.

## Task 4: `list` grouped by kind, with `--kind`

**Files:** `lib/cli/local.ts` (`runList`, `formatLocalList`),
`lib/cli/local.test.ts`, `scripts/agency.ts`.

1. `formatLocalList` takes each downloaded model's kind (from
   `recordedKind`) and prints one section per kind in a fixed order
   (chat, embedding, speech, image, vision), each with name, engine,
   size, and downloaded state. Models with no kind go in a last section
   titled `unknown` with the `--kind` hint.
2. `--kind <kind>` filters to one section. `--all` adds the catalog
   entries not downloaded, as the current list does.
3. Tests: a fixture cache with one model of each kind renders in order;
   `--kind image` renders one section; an unknown-kind directory renders
   the hint.
4. Commit: `list groups local models by kind`.

## Task 5: Catalog `category` becomes `kind` plus `tags`

**Files:** `lib/stdlib/modelCatalog.ts`, `lib/stdlib/localModels.ts`
(`AliasObject`, `ModelNameEntry`, `parseCatalog`), the catalog fetch
format, and their tests.

1. `ModelInfo` gains `kind: ModelKind` and `tags: string[]`; `category`
   is removed. Every entry is rewritten: `general` and its friends move
   to `tags`, `embedding`, `speech`, and `image` become `kind`, and chat
   entries get `kind: "chat"`.
2. `AliasObject.category` becomes `kind?` and `tags?`. `parseCatalog`
   reads both the new fields and, for one release, an old `category`
   field it maps the same way, so a remote catalog that has not been
   regenerated still loads.
3. The download picker's title shows tags after the size.
4. Tests: the catalog parses both shapes; every curated entry has a
   kind; the alias round-trip keeps kind and tags.
5. Commit: `Catalog entries carry a kind and tags, not a category`.

## Task 6: Per-model options by position

**Files:** `scripts/agency.ts`, `lib/cli/localServe.ts`,
`lib/cli/cliArguments.ts` if the vendored commander needs a hand (read
`docs/dev/cli/cli-arguments.md` and `vendored-commander.md` first).

1. A pure function in `localServe.ts`, `groupServeArgv(argv: string[]):
   ServeTarget[]` with `type ServeTarget = { model: string; draft?:
   string; draftTokens?: number }`, turns the raw argv after `serve`
   into one entry per model with the per-model options that followed
   it. It is a parser, so its order is its nature; it has no other
   state, and its tests are a table of argv in and targets out.
   commander keeps the flags declared so `--help` lists them, with the
   values ignored in favor of the grouping, which is what
   `cli-arguments.md` describes for the program's own flags.
2. `settings.draft` moves from `ChatServerSettings` to the planned
   model. A `--draft` before any model is refused: `"--draft goes after
   the chat model it drafts for: agency local serve <model> --draft
   <draft>"`.
3. The memory warning counts a draft once per model it is attached to.
4. Tests for the parse, the refusal, and the warning.
5. Changelog line under the next version.
6. Commit: `Per-model serve options attach to the model before them`.

## Task 7: The adapters folder

**Files:** `lib/config/config.ts` (`client.adaptersDir`),
`lib/cli/diffusersImageRules.py`, `lib/cli/diffusersImageServer.py`,
`lib/cli/diffusersImageServer.test.ts`, `lib/cli/localServe.ts`,
`docs/dev/llm/local-images.md`. Start from the spike's commit on this
branch; the SDXL family, the request fields, `apply_lora`, the provider
and stdlib changes, and their tests all stay.

1. Config: `client.adaptersDir?: string`, resolved relative to the
   config file's directory like `modelsDir`. `serve` passes it to every
   image process as `--adapters-dir <real path>`; no flag when unset.
2. Rules module: `parse_lora_flags` and `LORA_NAME_PATTERN` go.
   `adapter_path(adapters_dir, name)` returns the joined path for a
   name that is one path segment, not `.`, not `..`, and refuses
   anything else with the message from the spec. `check_request` takes
   `adapters_dir` (a string or None) instead of the loaded dict: a
   request naming an adapter with no folder configured gets the "set
   client.adaptersDir" message; with a folder, the name is checked for
   shape only, because whether the file exists is found out at load.
3. Server: `--adapters-dir`. `Generator.adapter(name)` loads
   `adapters_dir/name.safetensors` on first use, refusing a symlink or a
   missing file with a 400 that names the folder and the files in it
   that end in `.safetensors`, and keeps the loaded set in a dict. Loads
   happen under the generation lock. `apply_lora` is unchanged.
   `/health` lists the folder's adapter names, read fresh each call.
4. `checkLoraFlags` and the `--lora` flag on `serve` are removed, with
   their tests. `imageServeArgs` takes `adaptersDir: string | null`.
5. Tests: the Python rules for `adapter_path` (a segment, `..`, a
   slash, an empty name, an extension already given); the server test
   file's parse check; `imageServeArgs` with and without the folder;
   `runServe` passes the real path.
6. Docs: the LoRA section of `local-images.md` rewritten for the folder,
   the config doc gets the key, and the guide paragraph names it.
7. Commit: `LoRA adapters come from client.adaptersDir`.

## Task 8: Docs and the index

**Files:** `docs/dev/llm/local-models.md`, `docs/dev/llm/local-images.md`,
`docs/site/cli/local.md`, `docs/site/guide/using-local-models.md`,
`docs/site/guide/agency-config-file.md`, `CLAUDE.md` and
`.claude/skills/agency-llm-docs/SKILL.md` (a line for `modelKind.ts`
under `local-models.md`'s entry).

1. Every place that says `--image <model>` becomes the flagless form,
   with one sentence that the flags still work as checks.
2. `local-models.md` gets a "Kinds" section: the type, the inference
   table, the record field, and the one-function rule.
3. Commit: `Docs for model kinds and the adapters folder`.

## Order and what can ship alone

Tasks 1 to 4 are the DX change and can be one PR. Task 5 is a second PR
because it touches the remote catalog format. Task 6 is a third,
because it changes `--draft`. Task 7 rebases the spike and is a fourth.
None of them stacks on another in the sense of `never-stack-prs`: each
is based on main, and 7 waits for 1 to merge rather than branching from
it.
