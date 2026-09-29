# Editing images on the local image server: implementation plan

**Spec:** `docs/superpowers/specs/2026-09-29-local-image-editing.md`.
**Review of the first draft:**
`docs/superpowers/plans/2026-09-29-local-image-editing-review.md`. All seven
of its points are in this version.

**Goal:** `generateImageLocal` takes pictures in. With `images`, FLUX.2
[klein] edits a picture from an instruction. With `startImage` and
`strength`, the other four families redraw a picture in a new style.

**Architecture:** A request is in one of four modes: plain, control,
reference, or img2img. Two tables in the rules module describe the modes.
`INPUT_IMAGES` has one row per image field, and each family row has a
`pipelines` key that names a diffusers class per mode. The code that checks a
request, decodes an image, fits it, and picks a pipeline reads the tables. It
has no branch per mode. ControlNet moves onto the tables first, with no
change in behavior. After that, a new mode is mostly new rows.

## Two PRs

| PR | Tasks | Based on |
|---|---|---|
| A: the tables and reference editing | 1 to 7 | `main` |
| B: image-to-image | 8 to 10 | `main`, after A merges |

PR B is opened after PR A merges, so neither PR is stacked on the other.

## Constraints

- The server never opens a path from a request. Every input image arrives as
  bytes that the stdlib read after an approval.
- Every check that can fail happens before the first `std::readImage`
  interrupt. A call that is going to fail asks for nothing.
- A rejection of any one file sends no request.
- `diffusersImageRules.py` imports no torch, no diffusers, and no Pillow.
- A call with no input image behaves as it does today and raises nothing.
- The nine security constraints in `docs/dev/llm/local-images.md` hold.
- No code to support symlinks. A symlinked input file is refused.
- `pnpm run fmt:ts` before each commit. Test output goes to a file.
- Run single test files only. CI runs the full suite.

## Design rules for this change

These come from `docs/dev/contributing/anti-patterns.md`. Check each task
against them before its commit.

1. **No branch on the mode outside the rules module's table readers.** If
   you are about to write `if request["controlnet"] is not None` or `if mode
   == "img2img"` in the server or in `image.ts`, the fact belongs in a table
   row instead. `pipeline_args` is the one exception, and the spec says why.
2. **The checked request is never changed.** Values that depend on a decoded
   image, such as the output size, are computed by a function and passed as
   arguments.
3. **Every limit has one name per language.** No literal `4`, `20_000_000`,
   or `106_732_204` outside a constant's definition. A test compares the
   TypeScript table with the Python table.
4. **Reuse before writing.** `_imageSources`, `approvedFileBytes`,
   `image_bytes_of`, `letterbox`, and the decoder inside `control_image`
   already exist. Extend them or move them. Do not copy them.

## Task 1: The front door

**Files:** `lib/serve/util.ts`, `lib/cli/mlxServer.ts`,
`lib/cli/mlxServer.test.ts`, `lib/cli/serveLog.ts`,
`lib/cli/serveLog.test.ts`, `lib/stdlib/localImageInputs.ts` (new).

This task fixes two bugs that exist today. The front door refuses a body
over 10 MB, so a control image over about 7.5 MB fails with a 413. With
`--verbose`, it prints a control image as megabytes of base64.

1. `localImageInputs.ts` holds the TypeScript table and the limits computed
   from it:

   ```ts
   export type LocalImageField = {
     mode: "control" | "reference" | "img2img";
     maxCount: number;
     maxBytes: number;
     question: string;
   };

   export const MAX_CONTROL_IMAGE_BYTES = 50_000_000;
   export const MAX_INPUT_IMAGE_BYTES = 20_000_000;
   export const MAX_REFERENCE_IMAGES = 4;
   export const REQUEST_SETTINGS_BYTES = 64 * 1024;

   export const LOCAL_IMAGE_FIELDS: Record<string, LocalImageField> = {
     control_image: {
       mode: "control",
       maxCount: 1,
       maxBytes: MAX_CONTROL_IMAGE_BYTES,
       question: "Read this drawing to condition the image on?",
     },
   };
   ```

   PR A adds the `images` row in Task 5, and PR B adds `start_image`.
   `localBodyBytes()` returns `REQUEST_SETTINGS_BYTES` plus the base64
   length of the largest `maxCount * maxBytes` in the table.
2. `parseJsonBody(req, maxBytes = MAX_BODY_BYTES)`. The other callers pass
   nothing and keep 10 MB.
3. `mlxServer.ts`: `readRequest(req, maxBytes)`. The caller passes
   `localBodyBytes()` when `req.url` is `/v1/images/generations`, and the
   default for every other path.
4. `serveLog.ts`: `describeRequest` replaces the value of each field named
   in `LOCAL_IMAGE_FIELDS` with a note, `<1 image, 5.0 MB>` or `<3 images,
   4.2 MB>`. The size is the decoded size, computed from the base64 length.
5. Tests:
   - `mlxServer.test.ts`: a 20 MB body to `/v1/images/generations` reaches
     the upstream server whole, with every field unchanged. A 20 MB body to
     `/v1/chat/completions` gets a 413. A body over `localBodyBytes()` to
     the image route gets a 413.
   - `serveLog.test.ts`: a request with a control image is logged with the
     note and without the base64. A chat request is logged as before.
6. Commit: `The local front door takes image requests up to the image server's limit`.

## Task 2: The tables, with ControlNet moved onto them

**Files:** `lib/cli/localServerCommon.py`, `lib/cli/diffusersImageRules.py`,
`lib/cli/diffusersImageServer.py`, `lib/cli/diffusersImageServer.test.ts`.

No behavior changes in this task. Every existing rules test passes with its
expectations unchanged, apart from the two tests that name the replaced
keys.

Rules module:

1. `image_bytes_of(value, max_bytes = MAX_IMAGE_BYTES)`.
2. `INPUT_IMAGES` with the `control_image` row only. `MODE_FIELDS` lists the
   fields of each mode: `{"control": ["controlnet", "control_image",
   "control_scale", "control_invert"]}`.
3. Each family row gets `pipelines`. `pipeline`, `takes_controlnet`, and
   `controlnet_pipeline` are removed. Update the comment block above
   `FAMILIES`.
4. `mode_of(rules, body)` returns the mode and makes the three refusals in
   the spec. The refusal for a family with no pipeline keeps today's
   message for ControlNet.
5. `input_bytes(body, field)` returns a list of bytes. It applies the row's
   `max_count` and `max_bytes`, and names the entry in a refusal:
   `images[2]: image is not valid base64.`
6. `_controlnet_of` keeps what is specific to a ControlNet: the pairing of
   `controlnet` with `control_image`, the folder, the name, the scale, and
   the invert. Its image decoding and its family check move to steps 4
   and 5.
7. `fit_box(fit, source_width, source_height, width, height)` returns
   `(scaled width, scaled height, left, top)`. `letterbox` becomes its
   `"letterbox"` case. `"none"` returns the source size at 0, 0.
8. `check_request` returns `mode`, `image_field` as the field's name or
   `None`, `size` as `(width, height)` or `None`, and `input_images` as a
   list of bytes. It no longer returns `width`,
   `height`, or `control_image`.
9. `output_size(size, first_image_size)` follows the table in the spec.
   `derived_size(width, height)` follows the four steps in the spec.
10. `pipeline_args(rules, request, width, height)` takes the size as
    arguments. It adds `controlnet_conditioning_scale` in control mode. The
    server adds the image itself, because that is a Pillow object.
11. `steps_run(rules, request)` returns the requested steps. Task 8 extends
    it.

Server:

12. `decode_image(data, field)` replaces the decoding at the top of
    `control_image`, and follows the four steps in the spec's "Decoding an
    input image". `CONTROL_IMAGE_FORMATS` becomes `INPUT_IMAGE_FORMATS`, and
    `MAX_CONTROL_IMAGE_PIXELS` becomes `MAX_INPUT_IMAGE_PIXELS`.
13. `fitted(image, field, width, height)` fits a decoded image with
    `fit_box` and the row's `fit`. A letterboxed image goes on a black
    canvas, as today.
14. `Generator.pipeline_for(request)` returns the pipeline for the request's
    mode. When the mode's class is the plain class, it returns `self.pipe`.
    Otherwise it builds the class from `self.pipe.components` on first use
    and keeps it. Control mode adds the loaded ControlNet, and its cache key
    includes the ControlNet's name. `control_pipeline` is removed.
15. `generate` becomes a sequence with no branch on the mode:

    ```python
    field = request["image_field"]
    images = [decode_image(data, field) for data in request["input_images"]]
    first_size = images[0].size if images else None
    width, height = output_size(request["size"], first_size)
    fitted_images = [fitted(image, field, width, height) for image in images]
    kwargs = pipeline_args(self.rules, request, width, height)
    ```

    Everything above runs before the lock. The control image's invert runs
    between decoding and fitting, from a `prepare` entry in the control row.
    Under the lock: `apply_lora`, `pipeline_for`, the call.
16. `MAX_BODY_BYTES` is computed from `INPUT_IMAGES`, as `localBodyBytes()`
    is in TypeScript.

Tests:

17. The existing test of family keys checks that every row has the same
    keys, that every mode named in a `pipelines` key is `plain` or a mode of
    `INPUT_IMAGES`, and that every row has `plain`.
18. `mode_of`: a plain request, a control request, `control_scale` with no
    image, and a control request to Z-Image.
19. `fit_box` for each fit. `output_size` for the three rows of its table.
    `derived_size` for the five pictures in the spec.
20. The Python `INPUT_IMAGES` and the TypeScript `LOCAL_IMAGE_FIELDS` have
    the same fields, counts, and byte caps. `MAX_BODY_BYTES` equals
    `localBodyBytes()`. Follow the existing test "allows no family more
    steps than the provider's timeout budgets".
21. The existing ControlNet rules tests and the script's syntax check pass.
22. Commit: `Input images and pipelines as tables in the image server`.

## Task 3: The stdlib's checks in one function

**Files:** `lib/stdlib/localImageInputs.ts`,
`lib/stdlib/localImageInputs.test.ts` (new), `lib/stdlib/image.ts`,
`lib/stdlib/image.test.ts`, `stdlib/image.agency`.

No behavior changes in this task either. The existing
`tests/agency-js/image-generation-local-controlnet` test passes unchanged.

1. Move the path checks inside `_imageSources` into a helper,
   `checkedImageFile(spelling, maxBytes, caller)`. It returns the real
   spelling. `_imageSources` calls it for each local path.
2. Types:

   ```ts
   export type LocalImageFile = {
     path: string;
     dir: string;
     filename: string;
     question: string;
   };

   export type LocalImageInputs = {
     field: string | null;
     files: LocalImageFile[];
     settings: Record<string, unknown>;
   };
   ```

   `field` is the request field the files go in, or `null` for a plain
   call. `settings` holds the mode's other request fields, such as
   `controlnet` and `control_scale`.
3. `_localImageInputs(controlnet, controlImage, controlScale,
   invertControlImage)` returns a `LocalImageInputs`. It throws for a
   ControlNet without an image or an image without a ControlNet, with
   today's message. It refuses a URL or a data URI: "generateImageLocal
   reads files on this machine only."
4. `_generateImageLocal` takes `inputs: LocalImageInputs` in place of
   `control`. It reads each file with `approvedFileBytes(file.path,
   row.maxBytes)`. It sends one base64 string when the row's `maxCount` is
   1, and a list otherwise. `controlFields` and `LocalControl` are removed.
5. `image.agency`: the ControlNet block of `generateImageLocal` becomes the
   snippet in the spec's "Approval" section. The pairing check in Agency
   code is removed, because `_localImageInputs` makes it.
6. Tests: `localImageInputs.test.ts` covers the pairing refusals, a missing
   file, a symlink, a file over the cap, and a URL. `image.test.ts` keeps
   its ControlNet cases.
7. `make`, because a stdlib file changed. Run the ControlNet agency-js test,
   with the output saved to a file.
8. Commit: `generateImageLocal checks its input files in one function`.

## Task 4: Reference mode on the server

**Files:** `lib/cli/diffusersImageRules.py`,
`lib/cli/diffusersImageServer.py`, `lib/cli/diffusersImageServer.test.ts`,
`lib/cli/diffusersImageServer.live.test.ts`.

1. `FIELDS` gains `images`. `INPUT_IMAGES` gains the `images` row from the
   spec, and `MODE_FIELDS` gains `"reference": ["images"]`.
2. klein's `pipelines` gains `"reference": "Flux2KleinPipeline"`.
3. `reference_problem(width, height)` returns a message for a side under 64
   pixels or a shape more extreme than 8 to 1, and `None` otherwise. The
   `images` row names it as its `check`, and `decode_image` runs a row's
   check after decoding.
4. `pipeline_args` passes a list of images in reference mode and one image
   otherwise. The row's `max_count` decides, so this is not a branch on the
   mode.
5. Tests, one `it` each:
   - references to Z-Image are refused, and the message names klein
   - five references are refused
   - `images` with `control_image` is refused
   - `reference_problem` for 63x500, 64x512, 100x801, and 1024x1024
   - an empty `size` with a reference returns `size` as `None`
6. Live test: serve klein, send one reference with an empty `size`, and
   check that the reply is an image of the derived size.
7. Commit: `Reference images on the image server`.

## Task 5: Reference mode in the provider and stdlib

**Files:** `lib/stdlib/mlxImage.ts`, `lib/stdlib/mlxImage.test.ts`,
`lib/stdlib/localImageInputs.ts` and test, `lib/stdlib/image.ts`,
`stdlib/image.agency`.

1. `LOCAL_IMAGE_FIELDS` gains the `images` row, with `MAX_REFERENCE_IMAGES`
   and the question "Read this picture to edit it?".
2. `_localImageInputs` gains `images: string[]`. It refuses two modes in one
   call and more than the row's `maxCount` paths. Both messages match the
   server's.
3. `mlxImage.ts`: `SETTINGS` gains `images`. `localImageTimeoutMs(steps,
   size, references = 0)` adds one megapixel per reference. An empty size is
   budgeted as 1024x1024, and a size that does not parse as the largest
   size. `_generateImageLocal` passes the number of references in
   `config.metadata.references`, which is not in `SETTINGS` and so is never
   sent.
4. `image.agency`: `size` defaults to `""`, and `images: string[] = []` goes
   last. The body of the function does not change, apart from the new
   argument to `_localImageInputs`.
5. The docstring: a paragraph on editing, and the `images` and `size`
   parameter lines from the spec.
6. Tests:
   - `mlxImage.test.ts`: four references add four megapixels of budget. An
     empty size has the budget of `"1024x1024"`.
   - `localImageInputs.test.ts`: five paths, `images` with `controlImage`, a
     21 MB file, a `.txt` file, and an `https://` URL are each refused.
   - `image.test.ts`: the request carries a list of base64 strings and no
     path.
7. `make`.
8. Commit: `images on generateImageLocal`.

## Task 6: The agency-js test

**Files:** `tests/agency-js/image-generation-local-edit/agent.agency`,
`test.js`, `fixture.json`. Copy the shape of
`tests/agency-js/image-generation-local-controlnet`.

Cases:

1. Two references raise two `std::readImage` interrupts, in order, each with
   the right `dir` and `filename`. After both approvals the stand-in server
   receives two base64 strings that decode to the files' bytes.
2. Rejecting the second interrupt sends no request.
3. A missing file fails with no interrupt.
4. Five paths fail with no interrupt.
5. A call with no `images` raises nothing, and the request has no `images`
   field.

Run it with `pnpm run agency test js
tests/agency-js/image-generation-local-edit`, with the output saved to a
file.

Commit: `Test approval of reference images`.

## Task 7: Measure, document, open PR A

**Files:** `docs/site/guide/image-generation.md`,
`docs/dev/llm/local-images.md`, `docs/dev/llm/mlx-local-models.md`,
`lib/stdlib/modelCatalog.ts`, `CLAUDE.md`, and the `agency-llm-docs` skill.

1. Measure on the M5 Ultra, through `generateImageLocal`. The commands go to
   the user to run, and the numbers go in the PR description.

   | Run | Record |
   |---|---|
   | The five fox edits from the spec | Result and seconds |
   | 1, 2, and 4 references at 1024x1024 | Seconds and peak GPU memory |
   | The one-hand wave at 8 steps | Whether it follows the instruction |
   | A portrait photo from a phone | That the result is upright |
   | A ControlNet request with a 10 MB drawing | That it succeeds |

2. Decide from the numbers:
   - the cap on references. To lower it, change `max_count` in the Python
     row and `MAX_REFERENCE_IMAGES` in TypeScript. The test from Task 2
     fails if only one changes, and both body limits follow.
   - whether the timeout's one megapixel per reference is enough. It is
     enough if the 4-reference run takes less than half its budget.
   - whether the `steps` docstring recommends 8 steps for edits.
3. `modelCatalog.ts`: the klein description says it edits pictures.
4. Guide: "Edit an image on your Mac", after "Pose an image with a
   ControlNet". A klein example, the approval flags to run it with, and the
   `editPicture` agent from the spec. Compile each example before it goes
   in.
5. `local-images.md`: the modes, the two tables, how to add a mode, the
   decode steps, the size rules, and the three size limits. Security
   constraints 7 and 9 are reworded to cover every input image. Update the
   approval section.
6. `mlx-local-models.md`: the front door's limit for the image route, and
   the note that replaces image fields in the log.
7. `CLAUDE.md` and the `agency-llm-docs` skill: update the index line for
   `local-images.md`. Fix the line for `local-vision.md`, which says "why an
   image is named by path and never sent". The doc itself says images are
   sent.
8. Read `docs/dev/contributing/verbal-tics.md` and check the new prose
   against it.
9. Commit: `Docs for editing images locally`. Open PR A against `main`.

## Task 8: Image-to-image on the server

**Files:** `lib/cli/diffusersImageRules.py`,
`lib/cli/diffusersImageServer.test.ts`,
`lib/cli/diffusersImageServer.live.test.ts`.

If Task 2 met its design rules, this task changes no line of
`diffusersImageServer.py`. If it needs one, fix the table reader and not the
caller.

1. `FIELDS` gains `start_image` and `strength`. `INPUT_IMAGES` gains the
   `start_image` row. `MODE_FIELDS` gains `"img2img": ["start_image",
   "strength"]`.
2. Four family rows gain an `img2img` pipeline. Every row gains
   `default_strength`, `img2img_takes_size`, and `img2img_steps`, with the
   values in the spec's table. klein's three are `None`.
3. `fit_box` gains the `"cover"` case.
4. `_strength_of(rules, body)` returns the strength or the family's default.
   It refuses a value that is not a number above 0 and at most 1.
5. `steps_run` uses the two formulas in the spec in img2img mode, chosen by
   `img2img_steps`. Write each formula exactly as diffusers does, so
   floating point rounds the same way. `check_request` refuses a request
   where it is 0.
6. `pipeline_args` adds `strength` in img2img mode, and leaves `width` and
   `height` out when `img2img_takes_size` is false.
7. The "Stopped after N of M steps" message uses `steps_run`. This is the
   one server line that may change.
8. Tests, one `it` each:
   - `strength` with no `start_image` is refused
   - `start_image` to klein is refused, and the message names the four
     families
   - `start_image` with `control_image` is refused
   - a strength of 0 and a strength of 1.5 are refused
   - `steps_run` for the four rows in the spec's table, and the refusal for
     SDXL at 28 steps and 0.03
   - `fit_box("cover", ...)` for a 4:3 picture into a square and a square
     into 16:9
   - SDXL's arguments have no `width`, and the other three have one
9. Live test: an image-to-image request, then a plain request with the same
   seed as a plain request made before it. The two plain images are equal.
10. Commit: `Image-to-image on the image server`.

## Task 9: Image-to-image in the stdlib

**Files:** `lib/stdlib/localImageInputs.ts` and test, `lib/stdlib/mlxImage.ts`,
`stdlib/image.agency`, `tests/agency-js/image-generation-local-edit/`.

1. `LOCAL_IMAGE_FIELDS` gains the `start_image` row, with the question "Read
   this picture to redraw it?".
2. `_localImageInputs` gains `startImage: string` and `strength: number |
   null`. `strength` goes in `settings`. `strength` without `startImage` is
   refused.
3. `SETTINGS` gains `start_image` and `strength`.
4. `image.agency`: `startImage: string = ""` and `strength: number | null =
   null` go last, with the docstring lines from the spec.
5. Tests: the refusals in `localImageInputs.test.ts`. The agency-js test
   gains a node for `startImage` with cases 1 to 3 and 5 of Task 6.
6. `make`.
7. Commit: `startImage and strength on generateImageLocal`.

## Task 10: Measure, document, open PR B

**Files:** `lib/cli/diffusersImageRules.py`,
`docs/site/guide/image-generation.md`, `docs/dev/llm/local-images.md`.

1. Measure on the M5 Ultra. One picture, one prompt, each of the four
   families, at strengths 0.3, 0.6, and 0.9. Paste the results into one
   sheet per family with `pasteImages`.
2. Set each `default_strength` to the value where the layout is kept and the
   style has changed. Record the sheets in the PR description.
3. Guide: an image-to-image example in "Edit an image on your Mac", with a
   sentence on when to use `startImage` and when to use `images`.
4. `local-images.md`: the three family keys, why the two step formulas
   differ, and why the start image is cropped and not letterboxed.
5. Commit: `Docs for image-to-image`. Open PR B against `main`.

## What could go wrong

| Risk | What to do |
|---|---|
| Moving ControlNet onto the tables changes its behavior | Tasks 2 and 3 change no test expectation. Task 7 runs a real ControlNet request. |
| An image-to-image run changes the next plain request through the shared scheduler | Unlikely. In diffusers 0.40, `set_timesteps` resets `_begin_index` on both schedulers these families use. The live test in Task 8 checks it. |
| Four references do not fit in memory on a smaller Mac | Task 7 measures it. Lower the cap. |
| A table grows a key that only one row uses, such as `prepare` or `check` | That is acceptable for a step one mode needs. If a third such key appears, stop and reconsider the table's shape before adding it. |
