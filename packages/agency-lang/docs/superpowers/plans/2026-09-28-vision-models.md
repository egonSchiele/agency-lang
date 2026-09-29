# `std::vision`: implementation plan

**Spec:** `docs/superpowers/specs/2026-09-28-vision-models.md`. Needs
Task 1 to 3 of the DX plan merged (the `vision` kind and flagless
`serve`).

**Goal:** A vision server script with a family table, three routes,
`std::vision` with `detectObjects`, `tagImage`, and `captionImage`, and
`cropImage` and `imageSize` in `std::image`, so a labeling loop is
twelve lines of user code over five single-purpose tools.

**Architecture:** `lib/cli/visionRules.py` holds the family table, the
route table, the path rules, and every request check, importing no
torch, so CI runs it. `lib/cli/visionServer.py` loads one model and
answers the routes its family lists. `lib/stdlib/vision.ts` is the
TypeScript half of the stdlib functions: it validates the approved path
and posts to the front door, in the shape of `_generateImageLocal`.
`lib/cli/imageTools.py` is the one-shot Pillow script that `cropImage`
and `imageSize` run. The `mlx` base URL and `isNoServerError` are
reused as they are.

## Constraints

- The rules module imports nothing from torch, transformers, or
  onnxruntime; a test checks the imports as the image rules test does.
- An image is named by path in a request and read by the server through
  a descriptor after the checks in the spec. The server never lists a
  directory and never writes.
- Every stdlib function resolves the path with `_realTarget` before the
  interrupt and re-validates with `_approvedFilePath` after, exactly as
  `readTextBlocks` does. No new path code.
- The one-shot Python imports Pillow only. It takes arguments on the
  command line and prints one JSON line.
- `pnpm run fmt:ts` before each commit; test output to a file.

## Task 1: Rules module and its tests

**Files:** Add `lib/cli/visionRules.py`, `lib/cli/visionServer.test.ts`,
and fixtures `tests/fixtures/visionModels/{wd14,florence2}/config.json`
(the real files, plus `selected_tags.csv` for WD14 trimmed to ten rows).

1. The family table, keyed by what identifies the model:

   ```python
   FAMILIES = {
       "wd14": {
           "label": "WD14 tagger",
           "engine": "onnxruntime",
           "identify": {"file": "model.onnx", "beside": "selected_tags.csv"},
           "routes": ["tags"],
           "input_size_from": "model",   # the ONNX input shape
       },
       "Florence2ForConditionalGeneration": {
           "label": "Florence-2",
           "engine": "transformers",
           "identify": {"config_architecture": "Florence2ForConditionalGeneration"},
           "runner": "Florence2Runner",
           "routes": ["detections", "tags", "captions"],
           "task_detections": "<OPEN_VOCABULARY_DETECTION>",
           "task_tags": "<DENSE_REGION_CAPTION>",
           "task_caption_short": "<CAPTION>",
           "task_caption_long": "<MORE_DETAILED_CAPTION>",
       },
   }
   ```

   with `"runner": "Wd14Runner"` on the first row. The row is flat: one
   key per value, no nested dicts, so a test can compare a row to a
   literal and a reader can find a task string with one grep.
   `family_of(model_dir_listing, config)` returns the row or raises
   `ValueError` naming what did not match, as the image rules do.
2. `ROUTES = {"detections": "/v1/vision/detections", ...}` and
   `check_request(rules, route, body)`: the shared fields (`model`,
   `image`), the route's own fields with their ranges (`labels` a
   non-empty list of non-empty strings, `threshold` 0 to 1, `limit` 1
   to 500, `detail` one of two), unknown fields refused naming the
   route's fields, and the route refused when the family does not list
   it, naming the routes it does.
3. `check_image_path(path)`: absolute, exists, a regular file, not a
   symlink at any component (walk the parts), an extension in the image
   set. Returns the path. Raises `RequestError` with the reason.
4. `MAX_BODY_BYTES`, `MAX_LABELS = 50`, `MAX_IMAGE_BYTES = 50_000_000`,
   and `DEFAULT_THRESHOLDS` per route, each named.
5. Tests through `python3`, in the shape of
   `diffusersImageServer.test.ts`: the two fixtures match their families;
   a `config.json` naming another class is refused; each route's field
   checks; the path checks against files made in a temp directory,
   including a symlink that the test creates and expects refused.
6. Commit: `Vision server rules`.

## Task 2: The server script

**Files:** Add `lib/cli/visionServer.py`. Read
`diffusersImageServer.py` and `localServerCommon.py` first; reuse
`client_gone` and `fail`.

1. `parse_args`: `--model`, `--host`, `--port`, same as the image server.
2. `Runner`: reads the directory listing and `config.json`, calls
   `family_of` before importing any engine, sets `HF_HUB_OFFLINE`, then
   imports the engine the row names and loads: `onnxruntime.InferenceSession`
   for WD14 with `providers=["CPUExecutionProvider"]`; `AutoModelForCausalLM`
   and `AutoProcessor` with `use_safetensors=True`, `local_files_only=True`,
   and no `trust_remote_code` for Florence-2, on `mps` when available.
3. One class per family, named by the row's `runner`, each with a
   method per route it lists and nothing else: `Wd14Runner.tags` is the
   spike's `tag_images.py` (the white-padded BGR preprocessing, the
   general-category filter, underscores to spaces); `Florence2Runner`
   has `detections`, `tags`, and `captions`, each one call to the model
   with the row's task string and one reshaping of the reply into the
   route's shape. The family decides the class; nothing in a route
   method asks which family it is. Boxes are normalized to top-left
   `{x, y, width, height}` by one function both runners call.
4. `Handler`: `GET /health` with `{"status", "routes"}`; `POST` on a
   route in `ROUTES` calls `getattr(runner, route)` after
   `check_request` confirmed the family lists it; 404 for others naming
   the routes. Under a lock; a hung-up client is checked once before
   running, as the image server does before it takes the lock.
5. Warm-up: one request on the family's first route against a 64×64
   image the script draws with Pillow into a temp file it removes, so a
   model that loads but cannot run fails before the port opens.
6. A syntax-only test in `visionServer.test.ts`, as the image server
   has.
7. Commit: `Vision server script`.

## Task 3: `serve` learns the kind

**Files:** `lib/cli/localServe.ts`, `lib/cli/localServe.test.ts`,
`lib/stdlib/modelKind.ts`, `lib/stdlib/modelCatalog.ts`,
`lib/cli/serveLog.ts`, `lib/stdlib/mlxServerModels.ts`.

1. `"vision"` joins `ServeKind`. `visionServerScript()`,
   `visionServeArgs`, `processLabel`, `BANNER_SUFFIX` (`(vision)`), and
   `readinessRequest` (`GET /health`) get their rows.
2. `MODULES_FOR_KIND.vision` is decided per family, not per kind:
   `planModel` reads the family's engine through a small exported table
   `lib/cli/visionFamilies.json` (engine per family key, checked against
   the Python table by a test) and asks for `onnxruntime` or
   `torch, transformers` accordingly. `PIP_FOR_MODULE.onnxruntime` is
   `onnxruntime==<pinned>`.
3. `kindOfModelDir` gains the `vision` rule from the spec.
4. Catalog rows `wd14-tagger` and `florence-2` with `kind: "vision"`,
   sizes from the Hub listing, licenses as declared. The download filter
   for a `vision` model keeps `config.json`, `*.safetensors`, `*.onnx`,
   `*.csv`, `*.json`, and `preprocessor_config.json`, and drops `.bin`.
5. `describeReply` in `serveLog.ts` summarizes a vision reply by count.
6. Tests: `runServe(["wd14-dir"])` spawns the vision script and imports
   only `onnxruntime`; a Florence directory imports torch and
   transformers; the banner suffix; the log line.
7. Commit: `serve runs vision models`.

## Task 4: `std::vision`

**Files:** Add `stdlib/vision.agency`, `lib/stdlib/vision.ts`,
`lib/stdlib/vision.test.ts`, and `tests/agency/vision.agency`. Read
`stdlib/ocr.agency` and `lib/stdlib/image.ts` (`_generateImageLocal`,
`checkLocalImageArgs`) first.

1. `vision.agency`: the effect with `@alwaysUnder(dir)`, the two types
   (`BoundingBox` imported from `std::ocr` rather than redeclared), and
   the three functions from the spec, each `idempotent`, each with the
   docstring and `@param` lines, each doing: `_realTarget`, the
   interrupt with `dir`, `filename`, `task`, and `model`, then
   `try _visionRequest(...)`.
2. `vision.ts`: one function `_visionRequest(task, spelling, model,
   fields)` that calls `_approvedFilePath(spelling)`, resolves the model
   with `_resolveModel` and refuses a non-vision one (the kind from
   `recordedKind`, with the serve command in the message), posts
   `{ model: servedName, image: path, ...fields }` to
   `${mlxBaseUrl()}/vision/${task}` with a timeout, and returns the
   reply's list or string as a `Result`. `isNoServerError` gives the
   "start one with" message. Three thin exports, `_detectObjects`,
   `_tagImage`, `_captionImage`, name the task and pick the reply
   field, so the Agency side imports one name per function as every
   stdlib module does.
3. Tests in `vision.test.ts` against a stand-in HTTP server, as
   `image.test.ts` does: the request body per function, the URL, the 404
   passthrough, the non-vision refusal, the no-server message, the
   symlink refusal from `_approvedFilePath`.
4. `tests/agency/vision.agency`: a handler that checks the interrupt
   payload (`task`, `model`, real `dir`) and rejects, so the test needs
   no server; and one that approves against `MLX_BASE_URL` pointed at a
   stand-in started by the test's own TypeScript helper, if the agency
   test harness allows one (check `docs/misc/TESTING.md`; else the
   payload test alone).
5. `make` to regenerate `docs/site/stdlib/vision.md`; add the module to
   the stdlib index page and the guide's local-models page.
6. Commit: `std::vision`.

## Task 5: `cropImage`, `imageSize`, and `pasteImages`

**Files:** `stdlib/image.agency`, `lib/stdlib/image.ts`, add
`lib/cli/imageTools.py`, `lib/stdlib/imageTools.ts`,
`lib/stdlib/imageTools.test.ts`, and `tests/agency/cropImage.agency`.

1. `imageTools.py`: three commands, each a function of its arguments
   that returns one dict the script prints as JSON, so the command table
   at the bottom is `COMMANDS = {"crop": crop, "size": size, "paste":
   paste}` and `main` is a lookup. `crop <in> <out> <x> <y> <w> <h> <pad>
   <square>`, box numbers normalized 0..1: the padded and clamped pixel
   box, the crop, the square pad with the edge color when asked, the
   write with mode `wx` (refuses to overwrite). `size <in>`. `paste <out>
   <columns> <in>...`: the inputs on a white canvas in rows of `columns`,
   each at its own size, cells sized to the largest, `wx`. This is the
   contact sheet and the before-and-after pair in one general tool.
2. `imageTools.ts`: `_runImageTool(args)` chooses the Python the way
   `serve` does (`choosePython` exported from `localServe.ts` with its
   inputs), spawns it with `stdio: pipe`, parses the one line, and turns
   a non-zero exit into a failure whose message is the script's stderr.
   `_cropImage(spelling, outSpelling, box, pad, square)` calls
   `_approvedFilePath` on the input and `fixedPath` on the output's
   parent before running. `_imageSize(spelling)` the same for one path.
3. `image.agency`: the `std::cropImage` effect and the three functions
   as in the spec. `pasteImages(paths, outPath, columns: 2)` raises
   `std::pasteImages` with every real input path in `files` and the real
   output, the way `applyPatch` lists its files, then runs `paste`. `cropImage` resolves both paths with `_realTarget`,
   checks `outDir` containment with the same helper `allowedPaths`
   users elsewhere use (find it in `stdlib/index.agency` before writing
   one), raises, then calls `_cropImage`. `imageSize` raises
   `std::readImage` with the real path, then calls `_imageSize`.
4. Tests: `imageTools.test.ts` against real PNGs the test writes with
   a few bytes of pixel data through Pillow itself, skipped when the
   Python is not there: geometry with and without `pad` and `square`,
   the refusal to overwrite, a symlinked input, a missing Python's
   message. `cropImage.agency` checks the payload's two real paths.
5. Commit: `cropImage and imageSize`.

## Task 6: The labeling loop as an example and a test

**Files:** `examples/labelCrops.agency`,
`tests/agency/labelCrops.agency`, `docs/site/guide/using-local-models.md`.

1. The twelve-line loop from the spec as an example, with a comment
   per line saying which tool it is and what the effect for it is.
2. A test that runs the loop over one fixture page against a stand-in
   vision server answering fixed boxes and tags, with `--approve` for
   the write and crop effects, and checks the sidecar files exist with
   the expected tags.
3. A guide section, "Label a folder of images", showing the loop and
   the three partial applications that narrow each tool.
4. Commit: `Labeling loop example and test`.

## Task 7: Live test and docs

**Files:** `lib/cli/visionServer.live.test.ts`,
`docs/dev/llm/local-vision.md`, `CLAUDE.md` and the llm docs skill
index, `docs/site/cli/local.md`.

1. The opt-in live test, gated on `AGENCY_VISION_MODEL_DIR` and
   `AGENCY_IMAGE_PYTHON`: start the real server on the WD14 fixture
   model, tag one drawing, expect at least one tag with a score above
   the threshold; on Florence-2, detect one labeled object in a fixture
   drawing of a chair.
2. `local-vision.md`: the families, the routes, the path rule and why
   images are named not sent, the one-shot Pillow script and why it is
   not a server, the timings from the live run, and the security list
   copied from `local-images.md` with the two additions.
3. Commit: `Vision docs and live test`.
